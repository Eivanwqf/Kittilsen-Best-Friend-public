// journal 归档模式（2026-08-01 用户决策）：40 篇日志默认 archived（正常对话零注入），
// 只有解锁"历史模式"才恢复 active 可检索。状态存 settings 表（key-value）。
import type { KbfDb } from '../db/client.js';

export type JournalMode = 'locked' | 'unlocked';

const MODE_KEY = 'journal_mode';

export function getJournalMode(db: KbfDb): JournalMode {
  const row = db.prepare('select value from settings where key = ?').get(MODE_KEY) as { value: string } | undefined;
  return row?.value === 'unlocked' ? 'unlocked' : 'locked';
}

// 切换模式：locked → 全部 journal 笔记 archived（检索/列表/图扩展自动排除）；
// unlocked → 全部恢复 active（可检索，仍带 ⏳ 标签 + 降权）
export function setJournalMode(db: KbfDb, mode: JournalMode): { changed: number; journalCount: number } {
  const status = mode === 'locked' ? 'archived' : 'active';
  const changed = db.prepare("update notes set status = ? where category = 'archive/journal' and status != ?").run(status, status).changes;
  db.prepare('insert into settings(key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(MODE_KEY, mode);
  const journalCount = (db.prepare("select count(*) c from notes where category = 'archive/journal'").get() as { c: number }).c;
  return { changed, journalCount };
}
