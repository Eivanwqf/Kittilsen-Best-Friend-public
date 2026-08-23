// 笔记详情聚合：本体 + 实体 + 演化事件 + 前驱/后继 + 相关链接
// M3 演化闭环：详情页一次拉全，演化链（前驱 → 本笔记 → 后继）由 superseded_by 为主链，
// evolution_events 提供事件审计（reason/类型/时间），两者互补。
import type { KbfDb } from '../db/client.js';
import { getNote, type NoteRow } from './notes.js';
import { getEntity, type EntityRow } from './entities.js';

export interface EvolutionEventRow {
  id: number;
  note_id: number;
  type: string;
  prev_id: number | null;
  next_id: number | null;
  reason: string;
  created_at: string;
}

export interface NoteDetail {
  note: NoteRow;
  entity: EntityRow | null;
  evolution: Array<EvolutionEventRow & { prevTitle: string | null; nextTitle: string | null }>;
  predecessors: Array<{ id: number; uid: string; title: string; valid_at: string | null; kind: string }>; // 被本笔记取代的旧笔记
  successor: { id: number; uid: string; title: string } | null; // 取代本笔记的新笔记
  related: Array<{ id: number; uid: string; title: string; status: string; kind: string }>; // note_links 双向
}

export function getNoteDetail(db: KbfDb, id: number): NoteDetail | null {
  const note = getNote(db, id);
  if (!note) return null;

  const entity = note.entity_id ? getEntity(db, note.entity_id) : null;

  // 演化事件：本笔记身上的事件（note_id=本笔记）+ 指向本笔记的事件（被取代时 prev_id=本笔记）
  const evolution = db
    .prepare(
      `select e.id, e.note_id, e.type, e.prev_id, e.next_id, e.reason, e.created_at,
              p.title as prevTitle, n.title as nextTitle
       from evolution_events e
       left join notes p on p.id = e.prev_id
       left join notes n on n.id = e.next_id
       where e.note_id = ? or e.prev_id = ? or e.next_id = ?
       order by e.id desc`,
    )
    .all(id, id, id) as Array<EvolutionEventRow & { prevTitle: string | null; nextTitle: string | null }>;

  // 前驱：被本笔记取代的旧笔记（仍在库，status=superseded）
  const predecessors = db
    .prepare('select id, uid, title, valid_at, kind from notes where superseded_by = ? order by id')
    .all(id) as Array<{ id: number; uid: string; title: string; valid_at: string | null; kind: string }>;

  // 后继：本笔记被谁取代
  const successorRow = note.superseded_by
    ? (db.prepare('select id, uid, title from notes where id = ?').get(note.superseded_by) as
        | { id: number; uid: string; title: string }
        | undefined)
    : undefined;

  // 相关链接：note_links 双向插入，取对方笔记（去重）
  const related = db
    .prepare(
      `select distinct n.id, n.uid, n.title, n.status, l.kind
       from note_links l
       join notes n on n.id = case when l.source_id = ? then l.target_id else l.source_id end
       where (l.source_id = ? or l.target_id = ?) and n.id != ?
       order by n.id`,
    )
    .all(id, id, id, id) as Array<{ id: number; uid: string; title: string; status: string; kind: string }>;

  return {
    note,
    entity,
    evolution,
    predecessors,
    successor: successorRow ?? null,
    related,
  };
}
