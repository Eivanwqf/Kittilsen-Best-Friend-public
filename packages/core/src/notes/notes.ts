// 笔记查询层（M1：列表/详情，供 /api/notes 使用）
import type { KbfDb } from '../db/client.js';

export interface NoteRow {
  id: number;
  uid: string;
  title: string;
  content: string;
  category: string;
  tags: string;
  valid_at: string | null;
  confidence: number;
  source: string;
  source_ref: string | null;
  status: string;
  superseded_by: number | null;
  access_count: number;
  entity_id: number | null;
  kind: string;
  created_at: string;
  updated_at: string;
}

export interface NoteQuery {
  category?: string;
  status?: string;
  kind?: string;
  search?: string; // FTS trigram 关键词（≥3 字）
  limit: number;
  offset: number;
}

export function listNotes(db: KbfDb, q: NoteQuery): { rows: NoteRow[]; total: number } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (q.category) {
    // 子树匹配：'self' 命中 self + self/*（M4 分类树导航）；精确路径命中自身 + 子路径
    where.push(`(category = :category or category like :categorySub)`);
    params.category = q.category;
    params.categorySub = `${q.category}/%`;
  }
  if (q.status) {
    where.push(`status = :status`);
    params.status = q.status;
  } else {
    where.push(`status != 'archived'`);
  }
  if (q.kind) {
    where.push(`kind = :kind`);
    params.kind = q.kind;
  }
  if (q.search && q.search.length >= 3) {
    // trigram 索引要求 ≥3 字符
    where.push(`id in (select rowid from notes_fts where notes_fts match :search)`);
    params.search = q.search;
  }

  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  const total = (db.prepare(`select count(*) c from notes ${whereSql}`).get(params) as { c: number }).c;
  const rows = db
    .prepare(`select * from notes ${whereSql} order by valid_at desc limit :limit offset :offset`)
    .all({ ...params, limit: q.limit, offset: q.offset }) as NoteRow[];
  return { rows, total };
}

export function getNote(db: KbfDb, id: number): NoteRow | null {
  return (db.prepare('select * from notes where id = ?').get(id) as NoteRow | undefined) ?? null;
}

export function getNoteByUid(db: KbfDb, uid: string): NoteRow | null {
  return (db.prepare('select * from notes where uid = ?').get(uid) as NoteRow | undefined) ?? null;
}

export function touchNote(db: KbfDb, id: number): void {
  db.prepare('update notes set access_count = access_count + 1 where id = ?').run(id);
}
