// 数据迁移（#37 前任区门控）：10 条前任笔记 → life/relationships/exes
// 运行：npx tsx scripts/migrate-exes.ts（幂等，可重跑；只改 category 单列，不动 content/向量/FTS）
// 名单：32/33/34/35/60/98/99/100（CLAUDE.md）+ 31/97（源文件级描述，用户 2026-08-05 确认并入）
// 不迁：52 认识方式 / 55 关系形态（first-mistress 女主人域）、41/46/48/63（家人关系）
import 'dotenv/config';
import { openDatabase } from '../packages/core/src/db/client.js';

const EX_IDS = [31, 32, 33, 34, 35, 60, 97, 98, 99, 100];
const KEEP_IDS = [41, 46, 48, 52, 55, 63]; // 校验：不应被误迁

const db = openDatabase(process.env.DB_PATH ?? './data/kittilsen.db');

// 1. 分类树补行（seedCategories 等价物，幂等）
db.prepare("insert or ignore into categories(path, parent) values ('life/relationships/exes', 'life/relationships')").run();

// 2. 幂等迁移（category 已是的跳过）
const placeholders = EX_IDS.map(() => '?').join(',');
const info = db.prepare(
  `update notes set category = 'life/relationships/exes', updated_at = datetime('now')
   where id in (${placeholders}) and category != 'life/relationships/exes'`,
).run(...EX_IDS);
console.log(`迁移 ${info.changes} 条 → life/relationships/exes`);

// 3. 校验输出
const exes = db.prepare("select id, title from notes where category = 'life/relationships/exes' order by id").all() as Array<{ id: number; title: string }>;
console.log(`\nexes 分类现有 ${exes.length} 条：`);
for (const n of exes) console.log(`  ${n.id} | ${n.title}`);

const keepPh = KEEP_IDS.map(() => '?').join(',');
const bad = db.prepare(`select id, title from notes where id in (${keepPh}) and category = 'life/relationships/exes'`).all(...KEEP_IDS) as Array<{ id: number }>;
if (bad.length) {
  console.error('❌ 校验失败：以下笔记被误迁入 exes：', bad.map((n) => n.id).join(','));
  process.exit(1);
}
console.log('✅ 校验通过：52/55/41/46/48/63 未被误动');
