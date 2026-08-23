// planner 诊断：验证 timeWindow 输出（真实 LLM）
// 运行：npx tsx scripts/diag-planner.ts
import 'dotenv/config';
import { planMemory } from '../packages/core/src/retrieval/planner.js';

async function main() {
  const cases = ['我2018年写了什么？', '我6月健身练了什么？', '2020年11月我在想什么？', '高三的时候我在做什么？', '今天天气怎么样？'];
  for (const msg of cases) {
    const p = await planMemory(msg, []);
    console.log(
      `${msg}\n  → needsMemory=${p.needsMemory} mode=${p.mode} emotional=${p.emotional} timeWindow=${JSON.stringify(p.timeWindow)}\n  → queries=${JSON.stringify(p.queries)}\n`,
    );
  }
}

main().catch((e) => {
  console.error('diag 异常:', e);
  process.exit(1);
});
