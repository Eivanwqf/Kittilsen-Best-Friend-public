// 单条记忆写入管线（对话/手动共用）：LLM 分类 → 向量化 → 相关检索 → 演化判定 → 落库
// 与导入管线同一套判定规则，source = 'chat' | 'manual'
import type { KbfDb } from '../db/client.js';
import { embedder } from '../embed/embed.js';
import { knnSearch } from '../db/vector.js';
import { getNote, type NoteRow } from './notes.js';
import { createNote, createEvolutionEvent, linkNotes, supersedeNote } from './write.js';
import { classifyEvolution } from '../evolution/classify.js';
import { classifyCandidates } from '../import/classifier.js';
import { listCategories, seedCategories } from '../import/categories.js';

export interface WriteNoteResult {
  noteId: number;
  title: string;
  category: string;
  kind: string;
  evolutionType: string;
  reason: string;
  supersededIds: number[];
}

export async function createNoteFromText(
  db: KbfDb,
  text: string,
  opts: { source: 'chat' | 'manual'; title?: string; category?: string; kind?: string; validAt?: string } = { source: 'manual' },
): Promise<WriteNoteResult> {
  seedCategories(db);

  // 1. 分类（给了 category/kind 就跳过 LLM）
  let category = opts.category ?? '';
  let kind = opts.kind ?? '';
  if (!category || !kind) {
    const categories = listCategories(db);
    const [cl] = await classifyCandidates([{ title: opts.title ?? '新记忆', content: text, sourceRef: 'manual', truncated: false }], categories);
    category = category || cl!.category;
    kind = kind || cl!.kind;
  }

  // 2. 向量化
  const [vec] = await embedder.embed([`${opts.title ?? ''}\n${text}`]);

  // 3. 相关检索 + 演化判定
  const related: NoteRow[] = [];
  for (const h of knnSearch(db, Float32Array.from(vec!), 3)) {
    const note = getNote(db, h.noteId);
    if (note && note.status === 'active' && h.distance < 0.95) related.push(note);
  }
  const evo = await classifyEvolution(opts.title ?? '新记忆', text, related);

  // 4. 落库
  const noteId = createNote(db, {
    title: opts.title ?? text.slice(0, 20),
    content: text,
    category,
    kind,
    source: opts.source,
    sourceRef: opts.source === 'chat' ? 'chat' : 'manual',
    validAt: opts.validAt,
    vector: Float32Array.from(vec!),
  });
  createEvolutionEvent(db, {
    noteId,
    type: evo.type as 'NEW' | 'EXPAND' | 'CONFLICT' | 'EVOLVE',
    reason: evo.reason,
    prevId: evo.type === 'EVOLVE' && evo.supersedeNoteIds[0] ? evo.supersedeNoteIds[0] : undefined,
  });
  for (const rid of evo.relatedNoteIds) linkNotes(db, noteId, rid, 'related');
  for (const rid of evo.supersedeNoteIds) supersedeNote(db, rid, noteId);

  return { noteId, title: opts.title ?? text.slice(0, 20), category, kind, evolutionType: evo.type, reason: evo.reason, supersededIds: evo.supersedeNoteIds };
}
