// 向量存储操作（sqlite-vec，1024 维 bge-m3）
// 注意：sqlite-vec 0.1.9 对参数化 rowid 有 bug（Only integers are allows...），
// rowid 一律字面量拼接——rowid 由系统管理（INTEGER PRIMARY KEY），无注入面。
import type { KbfDb } from './client.js';

export function upsertVector(db: KbfDb, noteId: number, vector: Float32Array): void {
  // vec0 虚拟表对已存在 rowid 直接 insert 会 UNIQUE 冲突 → 先删后插
  const hex = Buffer.from(vector.buffer).toString('hex');
  db.exec(`delete from notes_vec where rowid = ${noteId}`);
  db.exec(`insert into notes_vec(rowid, v) values (${noteId}, x'${hex}')`);
}

export function deleteVector(db: KbfDb, noteId: number): void {
  db.prepare('delete from notes_vec where rowid = ?').run(noteId);
}

export interface KnnHit {
  noteId: number;
  distance: number;
}

export function knnSearch(db: KbfDb, vector: Float32Array, limit: number): KnnHit[] {
  const hex = Buffer.from(vector.buffer).toString('hex');
  const rows = db
    .prepare(`select rowid, distance from notes_vec where v match x'${hex}' order by distance limit ?`)
    .all(limit) as Array<{ rowid: number; distance: number }>;
  return rows.map((r) => ({ noteId: r.rowid, distance: r.distance }));
}
