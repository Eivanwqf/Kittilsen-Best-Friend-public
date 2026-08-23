// 导入管线：扫描记忆文件 → 解析候选 → 幂等过滤 → LLM 分类 → 向量化 →
// top-3 相关检索 → 演化判定 → dry-run 报告 → commit 落库（notes+links+events+向量）
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { KbfDb } from '../db/client.js';
import { embedder } from '../embed/embed.js';
import { knnSearch, upsertVector } from '../db/vector.js';
import { getNote, type NoteRow } from '../notes/notes.js';
import { createNote, createEvolutionEvent, linkNotes, supersedeNote } from '../notes/write.js';
import { classifyEvolution } from '../evolution/classify.js';
import { classifyCandidates } from './classifier.js';
import { parseMemoryFile, type NoteCandidate, type MemFileMeta } from './markdown-parser.js';
import { listCategories, seedCategories } from './categories.js';

export type ImportStatus = 'pending' | 'analyzing' | 'ready' | 'committed' | 'failed';

export interface ImportItem {
  index: number;
  file: string;
  title: string;
  content: string;
  category: string;
  kind: string;
  validAt?: string; // frontmatter 声明（日志写作日期）
  evolution: { type: string; reason: string };
  relatedNoteIds: number[];
  supersedeNoteIds: number[]; // 明确取代的笔记（仅这些会被标失效）
  hash: string;
  skipped: boolean; // 文件已导入（hash 幂等）
}

export interface ImportReport {
  items: ImportItem[];
  summary: { new: number; expand: number; conflict: number; evolve: number; skipped: number };
  totalTokens: number;
}

export interface ImportJob {
  id: number;
  uid: string;
  status: ImportStatus;
  sourceDir: string;
  report: ImportReport | null;
}

export function createImportJob(db: KbfDb, sourceDir: string): ImportJob {
  seedCategories(db);
  const res = db
    .prepare("insert into imports(uid, status, source_dir, created_at, updated_at) values (?, 'pending', ?, datetime('now', 'localtime'), datetime('now', 'localtime'))")
    .run(nanoid(), sourceDir);
  const id = Number(res.lastInsertRowid);
  return { id, uid: (db.prepare('select uid from imports where id = ?').get(id) as { uid: string }).uid, status: 'pending', sourceDir, report: null };
}

export function getImportJob(db: KbfDb, id: number): ImportJob | null {
  const row = db.prepare('select * from imports where id = ?').get(id) as
    | { id: number; uid: string; status: ImportStatus; source_dir: string; report: string | null }
    | undefined;
  if (!row) return null;
  return { id: row.id, uid: row.uid, status: row.status, sourceDir: row.source_dir, report: row.report ? JSON.parse(row.report) : null };
}

export function setImportStatus(db: KbfDb, id: number, status: ImportStatus, report?: ImportReport): void {
  db.prepare('update imports set status = ?, report = ?, updated_at = datetime(\'now\', \'localtime\') where id = ?').run(
    status,
    report ? JSON.stringify(report) : null,
    id,
  );
}

export function scanMemoryFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => path.join(dir, f));
}

function alreadyImported(db: KbfDb, file: string, hash: string): boolean {
  return !!db.prepare('select 1 from imported_files where file = ? and hash = ?').get(file, hash);
}

export async function analyzeImport(db: KbfDb, jobId: number, files: string[]): Promise<ImportReport> {
  setImportStatus(db, jobId, 'analyzing');

  // 1. 解析 + 幂等过滤
  const parsed: Array<{ meta: MemFileMeta; candidates: NoteCandidate[] }> = [];
  for (const f of files) {
    const p = parseMemoryFile(f);
    parsed.push(p);
  }
  const fresh = parsed.filter((p) => !alreadyImported(db, p.meta.name, p.meta.hash));
  const skippedFiles = parsed.length - fresh.length;

  const candidates: NoteCandidate[] = [];
  const candidateMeta: Array<{ file: string; hash: string }> = [];
  for (const p of fresh) {
    for (const c of p.candidates) {
      candidates.push(c);
      candidateMeta.push({ file: p.meta.name, hash: p.meta.hash });
    }
  }

  const items: ImportItem[] = [];

  // 2. LLM 分类（批量）
  const categories = listCategories(db);
  const classified = candidates.length ? await classifyCandidates(candidates, categories) : [];

  // 3. 逐条：向量化 → top-3 相关 → 演化判定
  let totalTokens = 0;
  const contentForEmbed = candidates.map((c, i) => `${c.title}\n${c.content}`);
  const vectors = candidates.length ? await embedder.embed(contentForEmbed) : [];

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i]!;
    const cl = classified.find((c) => c.index === i);
    const vec = vectors[i] ? Float32Array.from(vectors[i]!) : undefined;

    const related: NoteRow[] = [];
    if (vec) {
      const hits = knnSearch(db, vec, 3);
      for (const h of hits) {
        const note = getNote(db, h.noteId);
        if (note && note.status === 'active' && h.distance < 0.95) related.push(note);
      }
    }

    const evo = await classifyEvolution(cand.title, cand.content, related);
    totalTokens += 0; // 演化判定的 token 由调用方记录（chatJson 未透出 usage，MVP 略）

    items.push({
      index: i,
      file: candidateMeta[i]!.file,
      title: cand.title,
      content: cand.content,
      // 分类/类型优先级：frontmatter 声明（journal 固定）> LLM 分类 > 兜底
      category: cand.category ?? cl?.category ?? 'life/chapters',
      kind: cand.kind ?? cl?.kind ?? 'experience',
      validAt: cand.validAt,
      evolution: { type: evo.type, reason: evo.reason },
      relatedNoteIds: evo.relatedNoteIds,
      supersedeNoteIds: evo.supersedeNoteIds,
      hash: candidateMeta[i]!.hash,
      skipped: false,
    });
  }

  const summary = { new: 0, expand: 0, conflict: 0, evolve: 0, skipped: skippedFiles };
  const typeToKey: Record<string, keyof typeof summary> = { NEW: 'new', EXPAND: 'expand', CONFLICT: 'conflict', EVOLVE: 'evolve' };
  for (const it of items) {
    const key = typeToKey[it.evolution.type];
    if (key) summary[key]++;
  }

  const report: ImportReport = { items, summary, totalTokens };
  setImportStatus(db, jobId, 'ready', report);
  return report;
}

export async function commitImport(db: KbfDb, jobId: number): Promise<ImportReport | null> {
  const job = getImportJob(db, jobId);
  if (!job || job.status !== 'ready' || !job.report) return null;

  const { items } = job.report;
  const toCreate = items.filter((it) => !it.skipped);

  // 落库前批量向量化（analyze 阶段的向量未持久化，需重算一次）
  const contents = toCreate.map((it) => `${it.title}\n${it.content}`);
  const vectors = contents.length ? await embedder.embed(contents) : [];

  let v = 0;
  for (const it of items) {
    if (it.skipped) continue;

    // 向量按 toCreate 顺序生成，v 对每个非 skipped 条目推进（existing 分支也推进，防错位）
    const vector = vectors[v] ? Float32Array.from(vectors[v]!) : undefined;
    v++;

    // 已有同源笔记（同文件同标题）：内容/分类相同 → 跳过（幂等）；变化 → 更新（数据更新能力）
    const existing = db
      .prepare("select id, content, category, kind from notes where source = 'import' and source_ref = ? and title = ?")
      .get(it.file, it.title) as { id: number; content: string; category: string; kind: string } | undefined;
    if (existing) {
      if (existing.content === it.content && existing.category === it.category && existing.kind === it.kind) continue;
      // 内容/分类变化 → 更新笔记 + 向量（演化/链接不动：内容微调不重判演化）
      db.prepare("update notes set content = ?, category = ?, kind = ?, confidence = ?, updated_at = datetime('now', 'localtime') where id = ?").run(
        it.content,
        it.category,
        it.kind,
        it.category === 'archive/journal' ? 0.3 : 0.5,
        existing.id,
      );
      if (vector) upsertVector(db, existing.id, vector);
      continue;
    }

    // 相关笔记向量（用于 id 映射：relatedNoteIds 是分析时的 id，稳定）
    // 旧日志（archive/journal）confidence 设 0.3：多年以前的内容，语义上低置信
    const noteId = createNote(db, {
      title: it.title,
      content: it.content,
      category: it.category,
      kind: it.kind,
      source: 'import',
      sourceRef: it.file,
      vector,
      validAt: it.validAt,
      confidence: it.category === 'archive/journal' ? 0.3 : undefined,
    });
    // EVOLVE 时事件挂 prevId = 被取代的旧笔记，演化链可从事件表双向追溯
    createEvolutionEvent(db, {
      noteId,
      type: it.evolution.type as 'NEW' | 'EXPAND' | 'CONFLICT' | 'EVOLVE',
      reason: it.evolution.reason,
      prevId: it.evolution.type === 'EVOLVE' && it.supersedeNoteIds[0] ? it.supersedeNoteIds[0] : undefined,
    });
    // 链接全部相关笔记；只 supersede LLM 显式指定 + kind 允许的笔记
    for (const rid of it.relatedNoteIds) {
      linkNotes(db, noteId, rid, 'related');
    }
    for (const rid of it.supersedeNoteIds) {
      supersedeNote(db, rid, noteId);
    }
  }

  // 标记已导入文件
  const ins = db.prepare(
    "insert or ignore into imported_files(file, hash, import_id, imported_at) values (?, ?, ?, datetime('now', 'localtime'))",
  );
  const seen = new Set<string>();
  for (const it of items) {
    const key = `${it.file}::${it.hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ins.run(it.file, it.hash, jobId);
  }

  setImportStatus(db, jobId, 'committed', job.report);
  return job.report;
}
