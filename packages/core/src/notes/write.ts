// 笔记写入层：创建笔记 + 向量 + 演化事件 + 链接（导入/对话共用）
import { nanoid } from 'nanoid';
import type { KbfDb } from '../db/client.js';
import { upsertVector } from '../db/vector.js';
import type { EvolutionType } from '../evolution/classify.js';

export interface NewNoteInput {
  title: string;
  content: string;
  category: string;
  kind: string;
  source: 'import' | 'chat' | 'manual' | 'deduction';
  sourceRef?: string;
  validAt?: string | null;
  confidence?: number;
  entityId?: number | null;
  vector?: Float32Array; // 有则写向量表
}

export function createNote(db: KbfDb, input: NewNoteInput): number {
  const res = db
    .prepare(
      `insert into notes(uid, title, content, category, kind, source, source_ref, valid_at, confidence, entity_id, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'), datetime('now', 'localtime'))`,
    )
    .run(
      nanoid(),
      input.title,
      input.content,
      input.category,
      input.kind,
      input.source,
      input.sourceRef ?? null,
      input.validAt ?? null,
      input.confidence ?? 0.5,
      input.entityId ?? null,
    );
  const id = Number(res.lastInsertRowid);
  if (input.vector) upsertVector(db, id, input.vector);
  return id;
}

export function createEvolutionEvent(
  db: KbfDb,
  input: { noteId: number; type: EvolutionType; prevId?: number; nextId?: number; reason: string },
): void {
  db.prepare(
    "insert into evolution_events(note_id, type, prev_id, next_id, reason, created_at) values (?, ?, ?, ?, ?, datetime('now', 'localtime'))",
  ).run(input.noteId, input.type, input.prevId ?? null, input.nextId ?? null, input.reason);
}

export function linkNotes(db: KbfDb, sourceId: number, targetId: number, kind: 'related' | 'supersedes' | 'expand'): void {
  // 双向插入
  db.prepare(
    "insert or ignore into note_links(source_id, target_id, kind, created_at) values (?, ?, ?, datetime('now', 'localtime'))",
  ).run(sourceId, targetId, kind);
  db.prepare(
    "insert or ignore into note_links(source_id, target_id, kind, created_at) values (?, ?, ?, datetime('now', 'localtime'))",
  ).run(targetId, sourceId, kind);
}

export function supersedeNote(db: KbfDb, oldId: number, newId: number): void {
  db.prepare('update notes set status = ? , superseded_by = ? where id = ?').run('superseded', newId, oldId);
}
