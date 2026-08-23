// 写入管线 e2e：不同角度的自动演化验证（直调 core）
// 运行：npx tsx scripts/e2e-write-check.ts
// 用测试库 data/kbf-write-test.db（由主库复制而来），零污染主库；测完删测试库即可
import 'dotenv/config';
import { openDatabase } from '../packages/core/src/db/client.js';
import { createNoteFromText } from '../packages/core/src/notes/write-note.js';
import { getNote } from '../packages/core/src/notes/notes.js';

const db = openDatabase('data/kbf-write-test.db');

async function write(label: string, text: string, opts: Record<string, string> = {}) {
  const out = await createNoteFromText(db, text, { source: 'manual', ...opts });
  console.log(`\n[${label}]`);
  console.log(`  演化: ${out.evolutionType} | 分类: ${out.category} | 类型: ${out.kind}`);
  console.log(`  原因: ${out.reason.slice(0, 90)}`);
  for (const sid of out.supersededIds) {
    const s = getNote(db, sid);
    console.log(`  取代: 《${s?.title?.slice(0, 24)}》(id=${sid}, status=${s?.status})`);
  }
  const links = db.prepare('select count(*) c from note_links where source_id = ?').get(out.noteId) as { c: number };
  const vec = db.prepare('select count(*) c from notes_vec where rowid = ?').get(out.noteId) as { c: number };
  console.log(`  链接: ${links.c} 条 | 向量: ${vec.c === 1 ? '✓' : '✗'}`);
  return out;
}

async function main() {
  console.log('═══ 写入管线多角度 e2e（测试库）═══');
  await write('NEW-全新话题', '我最近开始学自由潜水，目标是下到 20 米深度。');
  await write('EXPAND-健身相关', '7月初加练了硬拉，从 40kg 加到 60kg，下背有感觉但不痛。');
  await write('EVOLVE-投资观点', 'AI 仓位已按计划清仓。回看这笔交易：情绪化追高是最大失误，以后 AI 链只做波段不长期持有。');
  await write('自动分类-运动', '周日晨跑 10km，配速 5:30，心率稳定。');
  await write('自动分类-exes', '和前任分开之后，我开始练习一个人生活，慢慢不害怕独处了。');
  await write('手动指定', '每天先写最难的 30 分钟，再处理琐事。', { category: 'self/principles', kind: 'principle' });
  // 真冲突：推翻 note 14 的"新能源长期持有不动摇" → 应触发 EVOLVE + supersede
  await write('EVOLVE-直接冲突', '新能源逻辑彻底变了：补贴退坡后增长放缓，不看好长期确定性了，等反弹就清仓新能源仓位。');

  console.log('\n═══ 汇总 ═══');
  const all = db.prepare('select count(*) c from notes').get() as { c: number };
  console.log(`测试库笔记总数: ${all.c}（主库 141 + 新增 6）`);
}

main().catch((e) => {
  console.error('e2e 写入测试异常:', e);
  process.exit(1);
});
