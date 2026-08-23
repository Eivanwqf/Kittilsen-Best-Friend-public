// 框架级 e2e-check：数据完整性 → API 层 → 检索 → 对话 SSE 全链路
// 运行：npx tsx scripts/e2e-check.ts（只读 + 幂等导入测试，无副作用落库）
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { openDatabase } from '../packages/core/src/db/client.js';
import { hybridSearch } from '../packages/core/src/retrieval/hybrid.js';
import { planMemory } from '../packages/core/src/retrieval/planner.js';

const API = 'http://localhost:8899';
// 本地私有路径（导入幂等测试用；public 不配置 → 跳过）
const MEM = process.env.E2E_MEM_DIR ?? '';

// 前任人名锚点测试（public 零人名）：E2E_NAMES 从 .env 注入（逗号分隔三个）——
// [0] 专名通道（2 字昵称类）、[1] 实体名通道（person 实体）、[2] 人名→实体通道（关系笔记）。
// 未配置 → 对应断言跳过（public 仓库无个人化数据）。本地 .env 配 E2E_NAMES=前任A,前任B,前任C 保回归覆盖。
const EX_NAMES = (process.env.E2E_NAMES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const ex0 = EX_NAMES[0];
const ex1 = EX_NAMES[1];
const ex2 = EX_NAMES[2];

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`);
}

// ──────────────────────────────────────────────
// 1. 数据完整性（直接查库，防"忘写向量/触发器不同步"类 bug 复发）
// ──────────────────────────────────────────────
console.log('── 数据完整性 ──');
const db = openDatabase(process.env.DB_PATH ?? './data/kittilsen.db');
const nNotes = (db.prepare('select count(*) c from notes').get() as { c: number }).c;
const nVec = (db.prepare('select count(*) c from notes_vec').get() as { c: number }).c;
check('notes 有数据', nNotes > 0, `${nNotes} 条`);
check('向量完整（notes_vec = notes）', nVec === nNotes, `vec ${nVec} / notes ${nNotes}`);

const nFts = (db.prepare('select count(*) c from notes_fts').get() as { c: number }).c;
check('FTS 同步（notes_fts = notes）', nFts === nNotes, `fts ${nFts} / notes ${nNotes}`);

const nEvo = (db.prepare('select count(*) c from evolution_events').get() as { c: number }).c;
check('演化事件已记录', nEvo >= nNotes, `${nEvo} 条（≥${nNotes}）`);

const persons = db.prepare("select count(*) c from entities where type='person'").get() as { c: number };
const entities = (db.prepare('select count(*) c from entities').get() as { c: number }).c;
if (persons.c > 0) {
  check('人物实体已建档', persons.c >= 1, `${persons.c} 个 person / 共 ${entities} 实体`);
} else {
  console.log('⏭️ 跳过人物实体断言（尚未录入人物，手动录入模式）');
}

// 幂等：重复导入同文件 → 全部 skipped（无副作用，只创建 dry-run job）
// 手动录入模式下 imported_files 为空 → 锚点缺失，跳过（2026-08-08 适配）
console.log('── 幂等导入 ──');
const idemFiles = (db.prepare('select count(*) c from imported_files').get() as { c: number }).c;
if (idemFiles > 0 && MEM) {
  const idemOut = execFileSync(
    'curl',
    ['-s', '-X', 'POST', `${API}/api/import`, '-H', 'Content-Type: application/json', '-d', JSON.stringify({ files: [`${MEM}/music.md`] })],
    { encoding: 'utf8' },
  );
  const idem = JSON.parse(idemOut).report as { summary: { skipped: number } };
  check('重复导入幂等', idem.summary.skipped === 1, `skipped=${idem.summary.skipped}`);
} else {
  console.log('⏭️ 跳过幂等导入断言（imported_files 为空，手动录入模式）');
}

// ──────────────────────────────────────────────
// 2. API 层
// ──────────────────────────────────────────────
console.log('── API 层 ──');
const health = JSON.parse(execFileSync('curl', ['-s', `${API}/api/health`], { encoding: 'utf8' }));
check('health 正常', health.ok === true && health.db.tables >= 20, `tables=${health.db.tables}`);

const notes = JSON.parse(execFileSync('curl', ['-s', `${API}/api/notes?limit=200`], { encoding: 'utf8' }));
// 列表默认排除 archived（journal 归档模式）——total 应对齐"非 archived"数
const nVisible = (db.prepare("select count(*) c from notes where status != 'archived'").get() as { c: number }).c;
check('GET /api/notes 返回全量', notes.total === nVisible, `total=${notes.total}`);

// ──────────────────────────────────────────────
// 3. 检索单元（不经 server，直接测 core）
// ──────────────────────────────────────────────
async function retrievalChecks() {
  console.log('── 检索 ──');
  const sem = await hybridSearch(db, '我以前怎么健身的');
  // 手动录入模式下库小：>=1 即可（锚点数据未录全时不再要求 3 条）
  check('hybrid 语义检索', sem.length >= 1 && sem[0]!.note.category.startsWith('lifestyle'), `top: ${sem[0]!.note.title.slice(0, 12)}`);

  // 实体名通道断言：EX_NAMES[1]（person 实体名）配置 + 库里有 person 实体才跑
  const hasPerson = db.prepare("select count(*) c from entities where type='person'").get() as { c: number };
  if (ex1 && hasPerson.c > 0) {
    const entName = await hybridSearch(db, ex1);
    check('hybrid 实体名通道', entName.length >= 1, `命中 ${entName.length} 条`);
  } else {
    console.log('⏭️ 跳过实体名通道断言（未配置 E2E_NAMES[1] 或无 person 实体）');
  }

  const p = await planMemory('今天天气怎么样', []);
  check('planner 短路', p.needsMemory === false, 'needsMemory=false');
  check('planner schema（mode/emotional）', (p.mode === 'analysis' || p.mode === 'casual') && typeof p.emotional === 'boolean', `mode=${p.mode} emotional=${p.emotional}`);
}

// ──────────────────────────────────────────────
// 4. 对话 SSE 全链路
// ──────────────────────────────────────────────
console.log('── 对话 SSE ──');
interface SseResult {
  planned: { needsMemory: boolean; queries: string[]; mode?: 'analysis' | 'casual'; emotional?: boolean } | null;
  injectedTitles: string[];
  injectedNotes: Array<{ title: string; content: string; category: string }>;
  suggestion: { title: string; category: string | null; content: string; kind?: string | null; validAt?: string | null } | null;
  done: boolean;
}
function chat(message: string): SseResult {
  const out = execFileSync(
    'curl',
    ['-s', '-N', '-X', 'POST', `${API}/api/chat`, '-H', 'Content-Type: application/json', '-d', JSON.stringify({ message, conversationId: 'e2e-check-conv' })],
    { encoding: 'utf8', timeout: 120_000 },
  );
  const result: SseResult = { planned: null, injectedTitles: [], injectedNotes: [], suggestion: null, done: false };
  let event = '';
  for (const line of out.split('\n')) {
    const l = line.trim();
    if (l.startsWith('event:')) event = l.slice(6).trim();
    else if (l.startsWith('data:')) {
      const data = JSON.parse(l.slice(5).trim());
      if (event === 'memory-planned') result.planned = data;
      else if (event === 'memory-injected') {
        result.injectedNotes = data.notes.map((n: { title: string; content: string; category: string }) => ({
          title: n.title,
          content: n.content,
          category: n.category,
        }));
        result.injectedTitles = result.injectedNotes.map((n) => n.title);
      } else if (event === 'memory-suggest') result.suggestion = data;
      else if (event === 'done') result.done = true;
    }
  }
  return result;
}

const c1 = chat('我以前怎么健身的？');
// title/content 双查：手动录入的标题可能是"26年6月的健身计划"（含"健身"不含"训练"）
check('健身语义 → 注入', c1.planned?.needsMemory && c1.injectedNotes.some((n) => /健身|训练|workout/.test(n.title + n.content)), `注入 ${c1.injectedNotes.length} 条`);
// #36/#37 条件断言：只有当 planner 自己的判定触发条件时才断言（LLM 波动不误报，只抓实现 bug）
if (c1.planned?.mode === 'casual') {
  check('casual 克制注入 ≤1 条', c1.injectedNotes.length <= 1, `注入 ${c1.injectedNotes.length} 条`);
}
if (c1.planned?.emotional === false) {
  check('非情感话题排除 exes', c1.injectedNotes.every((n) => !n.category.startsWith('life/relationships/exes')), `注入 ${c1.injectedNotes.length} 条`);
}

const c2 = ex0 ? chat(`${ex0}是谁？`) : null;
// 锚点：库里有含 ex0 的笔记才断言（E2E_NAMES 未配置或库里没有 → 跳过）
const hasEx0 = ex0
  ? (db.prepare('select count(*) c from notes where title like ? or content like ?').get(`%${ex0}%`, `%${ex0}%`) as { c: number })
  : { c: 0 };
if (c2 && hasEx0.c > 0) {
  check('专名 → 命中关系笔记', c2.injectedNotes.some((n) => n.title.includes(ex0) || n.content.includes(ex0)), `注入 ${c2.injectedNotes.length} 条`);
} else {
  console.log('⏭️ 跳过专名断言（未配置 E2E_NAMES[0] 或库中无该人名）');
}

const c3 = ex2 ? chat(`${ex2}是谁？`) : null;
// 锚点：库里有含 ex2 的实体才断言（人名在实体表，笔记文本可能没有）
const hasEx2 = ex2
  ? (db.prepare('select count(*) c from entities where title like ?').get(`%${ex2}%`) as { c: number })
  : { c: 0 };
if (c3 && hasEx2.c > 0) {
  check('人名 → 实体通道', c3.injectedTitles.length >= 1, `注入 ${c3.injectedTitles.length} 条`);
} else {
  console.log('⏭️ 跳过人名→实体断言（未配置 E2E_NAMES[2] 或库中无该实体）');
}

const c4 = chat('今天天气怎么样？');
check('无关 → 零注入', c4.planned?.needsMemory === false && c4.injectedTitles.length === 0, `needsMemory=${c4.planned?.needsMemory}`);

// ── 记忆建议（2026-08-23）：≥80 字长故事触发 memory-suggest；短消息零成本不判定 ──
const c5 = chat('你好');
check('短消息 → 无 memory-suggest', c5.suggestion === null, 'SUGGEST_MIN_CHARS 门限生效');

// 强叙事长消息（~120 字），提高 LLM 判定稳定性的构造样例
const story =
  '上周末我和大学同学老张、小陈回了一趟母校，路过当年我们熬夜通宵写毕业设计的实验室，如今改成了咖啡厅，三个人在门口站了很久，聊到凌晨一点才散，老张说他明年五月就要结婚了。';
const c6 = chat(story);
check('长故事 → 触发 memory-suggest', c6.suggestion !== null, c6.suggestion ? JSON.stringify(c6.suggestion).slice(0, 120) : '（未触发）');

// 条件断言：只有触发时才查字段合法性（LLM 波动最多挂上一条，不误报实现 bug）
const sg = c6.suggestion;
if (sg) {
  const KINDS = ['experience', 'preference', 'reading_note', 'essay', 'decision', 'principle'];
  check(
    'suggest 字段合法',
    sg.title.length >= 1 && sg.title.length <= 30 && sg.content.length >= 1 && sg.content.length <= 300 &&
      (!sg.kind || KINDS.includes(sg.kind)) && (!sg.validAt || /^\d{4}-\d{2}-\d{2}$/.test(sg.validAt)),
    `title=${sg.title.length} content=${sg.content.length} kind=${sg.kind ?? '∅'} validAt=${sg.validAt ?? '∅'}`,
  );
  const validCats = new Set((db.prepare('select path from categories').all() as Array<{ path: string }>).map((r) => r.path));
  check('suggest category 合法（分类树内）', !sg.category || validCats.has(sg.category), `category=${sg.category ?? '（省略）'}`);
}

// ──────────────────────────────────────────────
// 4.5 时区（2026-08-08 v4）：新写入路径必须是本地（GMT+8），无 8h 偏移
// ──────────────────────────────────────────────
const conv = db.prepare('select updated_at from conversations order by id desc limit 1').get() as { updated_at: string };
const localNow = db.prepare("select datetime('now', 'localtime') t").get() as { t: string };
const toTs = (s: string) => new Date(s.replace(' ', 'T')).getTime();
const diffMin = Math.abs(toTs(conv.updated_at) - toTs(localNow.t)) / 60000;
check('会话时间本地化（无 8h 偏移）', diffMin < 120, `updated_at=${conv.updated_at} 本地now=${localNow.t} 差 ${Math.round(diffMin)} 分钟`);
// 笔记写入路径时区：创建测试笔记 → created_at 应为本地（<5 分钟）→ 删除
const wOut = JSON.parse(
  execFileSync('curl', ['-s', '-X', 'POST', `${API}/api/notes`, '-H', 'Content-Type: application/json', '-d', JSON.stringify({ text: '【e2e时区】临时验证，随后删除' })], {
    encoding: 'utf8',
    timeout: 120_000,
  }),
);
const wid = wOut?.result?.noteId as number | undefined;
if (wid) {
  const wn = db.prepare('select created_at from notes where id = ?').get(wid) as { created_at: string };
  const wdiff = Math.abs(toTs(wn.created_at) - toTs(localNow.t)) / 60000;
  check('笔记写入时间本地化', wdiff < 5, `created_at=${wn.created_at} 差 ${Math.round(wdiff)} 分钟`);
  db.prepare('delete from evolution_events where note_id = ?').run(wid);
  db.prepare('delete from notes_vec where rowid = ?').run(wid);
  db.prepare('delete from notes where id = ?').run(wid);
} else {
  console.log('⏭️ 跳过笔记写入时区断言（写入失败）');
}

// ──────────────────────────────────────────────
main().catch((err) => {
  console.error('E2E 脚本异常:', err);
  process.exit(1);
});

async function main() {
  await retrievalChecks();

  // 清理 e2e 固定测试会话（不污染侧边栏）
  db.prepare("delete from messages where conversation_id = (select id from conversations where uid = 'e2e-check-conv')").run();
  db.prepare("delete from conversations where uid = 'e2e-check-conv'").run();

  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length} 项检查，${checks.length - failed} 通过，${failed} 失败`);
  console.log(failed === 0 ? 'E2E CHECK PASS' : 'E2E CHECK FAIL');
  process.exit(failed === 0 ? 0 : 1);
}
