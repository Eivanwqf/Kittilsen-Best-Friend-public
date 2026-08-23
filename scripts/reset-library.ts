// 全量重置（2026-08-08 用户决策）：清空所有记忆/分类/实体/演化/链接/向量/FTS/导入记录/对话
// ⚠️ 破坏性操作！执行前请先备份（GET /api/export 或 cp data/kittilsen.db data/backups/）
// 运行：npx tsx scripts/reset-library.ts
// 保留：settings（journal_mode）、schema 版本（user_version）
// 耦合处理：先删子表（FK 依赖顺序）→ notes（FTS 触发器自动清 notes_fts）→ vec0 向量表无级联需手动 → 实体/分类/导入记录 → sqlite_sequence 复位
import 'dotenv/config';
import { openDatabase } from '../packages/core/src/db/client.js';

const db = openDatabase(process.env.DB_PATH ?? './data/kittilsen.db');

const counts: Array<[string, number]> = [];
const del = (sql: string) => db.prepare(sql).run().changes;

db.exec('begin');
try {
  // 1. 子表（引用 notes/entities）
  counts.push(['note_links', del('delete from note_links')]);
  counts.push(['evolution_events', del('delete from evolution_events')]);
  // 2. 对话（messages.injected_note_ids 溯源已删笔记 → 一并清，避免死链）
  counts.push(['messages', del('delete from messages')]);
  counts.push(['conversations', del('delete from conversations')]);
  // 3. 主表
  counts.push(['notes', del('delete from notes')]); // notes_fts 由 ad 触发器同步清空
  counts.push(['notes_vec', del('delete from notes_vec')]); // vec0 无级联
  // 4. 被引用方
  counts.push(['entities', del('delete from entities')]);
  counts.push(['categories', del('delete from categories')]);
  // 5. 导入记录（幂等 hash 一并清，避免旧文件误判）
  counts.push(['imported_files', del('delete from imported_files')]);
  counts.push(['imports', del('delete from imports')]);
  // 6. autoincrement 序列复位（下次写入 id 从 1 开始）
  del('delete from sqlite_sequence');
  db.exec('commit');
} catch (err) {
  db.exec('rollback');
  console.error('❌ 重置失败（已回滚，数据未动）:', err);
  process.exit(1);
}

// 验证
const v = (t: string) => (db.prepare(`select count(*) c from ${t}`).get() as { c: number }).c;
console.log('已清空：');
for (const [t, n] of counts) console.log(`  ${t}: ${n} 条`);
const checks = ['notes', 'notes_vec', 'notes_fts', 'entities', 'categories', 'note_links', 'evolution_events', 'conversations', 'messages'];
const zero = checks.every((t) => v(t) === 0);
console.log(`\n验证：${checks.map((t) => `${t}=${v(t)}`).join(' ')}`);
console.log(zero ? '✅ 全部归零，重置完成' : '❌ 有残留！');
process.exit(zero ? 0 : 1);
