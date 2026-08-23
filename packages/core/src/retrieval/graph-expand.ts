// 图扩展：从检索命中出发，沿链接图 2-hop 扩展 + 实体扩展（同书/同影的笔记串联）
import type { KbfDb } from '../db/client.js';
import { getNote, type NoteRow } from '../notes/notes.js';

const MAX_EXTRA = 6; // 最多额外带出多少条
const MAX_HOP = 2;
// 语义门控阈值：扩展邻居需与查询向量 L2 距离 < 此值（与检索 dense 通道同阈值）
const EXPAND_MAX_DISTANCE = 0.95;

export function graphExpand(db: KbfDb, seeds: NoteRow[], queryVector?: Float32Array): NoteRow[] {
  const result = new Map<number, NoteRow>();
  for (const s of seeds) result.set(s.id, s);

  // 1-hop + 2-hop：沿 note_links 走
  let frontier = seeds.map((s) => s.id);
  for (let hop = 0; hop < MAX_HOP && frontier.length > 0 && result.size < seeds.length + MAX_EXTRA; hop++) {
    const next: number[] = [];
    for (const id of frontier) {
      const neighbors = db
        .prepare(
          `select target_id as nid from note_links where source_id = ?
           union select source_id as nid from note_links where target_id = ?`,
        )
        .all(id, id) as Array<{ nid: number }>;
      for (const n of neighbors) {
        if (result.has(n.nid)) continue;
        const note = getNote(db, n.nid);
        if (!note || note.status === 'archived') continue;
        // 语义门控（2026-08-01）：扩展邻居需与查询相关，防止"档案中心"节点
        // （Attempt 1/2 等 22 链接枢纽）在泛话题检索中反复被带出
        if (queryVector) {
          const v = getVector(db, n.nid);
          if (!v || l2Distance(v, queryVector) >= EXPAND_MAX_DISTANCE) continue;
        }
        result.set(n.nid, note);
        next.push(n.nid);
        if (result.size >= seeds.length + MAX_EXTRA) break;
      }
      if (result.size >= seeds.length + MAX_EXTRA) break;
    }
    frontier = next;
  }

  // 实体扩展：seed 挂实体的 → 同实体下的其他 active 笔记（同一实体天然相关，不过门控）
  for (const s of seeds) {
    if (!s.entity_id) continue;
    const siblings = db
      .prepare("select * from notes where entity_id = ? and status = 'active' and id != ?")
      .all(s.entity_id, s.id) as NoteRow[];
    for (const n of siblings) {
      if (result.size >= seeds.length + MAX_EXTRA) break;
      if (!result.has(n.id)) result.set(n.id, n);
    }
  }

  return [...result.values()];
}

// 取笔记向量（notes_vec，用于扩展门控的距离计算）
function getVector(db: KbfDb, noteId: number): Float32Array | null {
  const row = db.prepare('select v from notes_vec where rowid = ?').get(noteId) as { v: Buffer } | undefined;
  if (!row) return null;
  return new Float32Array(row.v.buffer, row.v.byteOffset, row.v.byteLength / 4);
}

// L2 距离（bge-m3 归一化向量，与 knnSearch 同一度量）
function l2Distance(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    sum += d * d;
  }
  return Math.sqrt(sum);
}
