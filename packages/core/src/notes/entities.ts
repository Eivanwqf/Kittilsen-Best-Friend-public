// 实体层（person 实体 = 人生中一个人的完整档案）
// 2026-08-08：实体管线脱离导入——手动录入/编辑也能创建和挂载实体
import { nanoid } from 'nanoid';
import type { KbfDb } from '../db/client.js';

export interface EntityRow {
  id: number;
  uid: string;
  type: 'book' | 'movie' | 'music' | 'game' | 'place' | 'person';
  title: string;
  creator: string | null;
  year: number | null;
  meta: string;
  created_at: string;
  updated_at: string;
}

export function getEntity(db: KbfDb, id: number): EntityRow | null {
  return (db.prepare('select * from entities where id = ?').get(id) as EntityRow | undefined) ?? null;
}

// 该实体下的所有笔记（person 实体 = 与某人的全部故事）
export function listNotesByEntity(db: KbfDb, entityId: number): Array<{ id: number; title: string; content: string; valid_at: string | null; status: string }> {
  return db
    .prepare("select id, title, content, valid_at, status from notes where entity_id = ? and status != 'archived' order by valid_at")
    .all(entityId) as Array<{ id: number; title: string; content: string; valid_at: string | null; status: string }>;
}

export function listEntities(db: KbfDb): EntityRow[] {
  return db.prepare('select * from entities order by type, title').all() as EntityRow[];
}

// 创建实体（幂等：同 type + 同 title 返回已有 id，不重复建）
export function createEntity(
  db: KbfDb,
  input: { type: EntityRow['type']; title: string; creator?: string; year?: number },
): number {
  const title = input.title.trim();
  if (!title) throw new Error('实体标题不能为空');
  const existing = db.prepare('select id from entities where type = ? and title = ?').get(input.type, title) as { id: number } | undefined;
  if (existing) return existing.id;
  const res = db
    .prepare('insert into entities(uid, type, title, creator, year) values (?, ?, ?, ?, ?)')
    .run(nanoid(), input.type, title, input.creator ?? null, input.year ?? null);
  return Number(res.lastInsertRowid);
}
