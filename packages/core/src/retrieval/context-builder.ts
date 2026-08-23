// 上下文构建：检索命中的笔记 → 注入文本（身份前缀 + 时间 + 来源 + 失效标注）
// 身份三态：📚读过（作品类实体）/ ✍️写过（essay）/ 🧠经历过（其余 + person/place 实体）
import type { NoteRow } from '../notes/notes.js';
import { getNote } from '../notes/notes.js';
import { getEntity } from '../notes/entities.js';
import type { KbfDb } from '../db/client.js';

export const MAX_MEMORY_CHARS = 2500;

export interface BuiltMemory {
  text: string; // 注入文本（≤2500 字）
  noteIds: number[]; // 注入的笔记 id（溯源，存 messages.injected_note_ids）
}

// 身份判定：挂实体的笔记看实体类型——作品类(book/movie/music/game) = 📚读过；
// 人/地点实体 = 🧠经历过（与某人的故事是经历，不是"读过"）
// journal（日志）= ⏳过往：过去的记录/时间胶囊，与当前记忆区分（2026-08-01 用户决策）
// reading_note = 📚读过：读书笔记天然是"读过"身份，不依赖实体挂载（2026-08-08 手动录入无实体修复）
export function identityOf(db: KbfDb, note: NoteRow): 'read' | 'wrote' | 'lived' | 'past' {
  if (note.category === 'archive/journal') return 'past';
  if (note.kind === 'reading_note') return 'read';
  if (note.entity_id) {
    const ent = getEntity(db, note.entity_id);
    if (ent?.type === 'person' || ent?.type === 'place') return 'lived';
    return 'read';
  }
  if (note.kind === 'essay') return 'wrote';
  return 'lived';
}

const IDENTITY_PREFIX: Record<'read' | 'wrote' | 'lived' | 'past', string> = {
  read: '📚读过',
  wrote: '✍️写过',
  lived: '🧠经历过',
  past: '⏳过往',
};

export function buildMemoryContext(db: KbfDb, notes: NoteRow[], maxChars: number = MAX_MEMORY_CHARS): BuiltMemory {
  const lines: string[] = [];
  const noteIds: number[] = [];
  let used = 0;

  // 排序：active 优先（superseded 沉底），其余保持检索得分序（传入顺序）。
  // 2026-08-01 修复：此前按时间新→旧重排，会把精确命中（人名实体等）挤出注入——
  // 注入顺序 = 相关性（RRF 得分），时间过滤应由 planner timeWindow 负责，不在这里重排。
  const sorted = [...notes].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    return 0; // 稳定排序 → 保持检索得分顺序
  });

  for (const n of sorted) {
    const time = n.valid_at;
    let line: string;
    if (n.status === 'superseded') {
      // 失效笔记：只放摘要 + 失效标注 + 后继跳转
      const next = n.superseded_by ? getNote(db, n.superseded_by) : null;
      line = `${IDENTITY_PREFIX[identityOf(db, n)]}[${time?.slice(0, 10) ?? '时间未知'}]【已失效·${n.title}】${n.content.slice(0, 60)}${next ? `（后继：${next.title}）` : ''}`;
    } else {
      line = `${IDENTITY_PREFIX[identityOf(db, n)]}[${time?.slice(0, 10) ?? '时间未知'}] ${n.title}：${n.content}`;
    }
    if (used + line.length > maxChars) break;
    lines.push(line);
    noteIds.push(n.id);
    used += line.length;
  }

  return { text: lines.join('\n'), noteIds };
}

// 系统提示词：注入 = 背景知识（2026-08-08 用户决策：平时不主动"你曾经说xxx"，自然融合；
// 只有 ⏳ 过往（历史模式翻日志）才点明"你当年记录过"）
// #36 场景分级：mode=analysis 强化呼应式、允许多条记忆交叉印证；mode=casual 克制（≤1 条）
// 2026-08-23 整理：新增"零注入"前置说明——无注入段 = 对 用户 过去一无所知，
// 堵死"你总是/你以前说过"类编造（实测 08-23 会话零注入时 LLM 伪造"你以前说过跟墙说话"等）；
// 规则 6 加认错机制：被指出记错立即承认，不"记岔了"圆场后继续编
export function buildSystemPrompt(mode: 'analysis' | 'casual' = 'analysis'): string {
  const modeRules =
    mode === 'casual'
      ? `5. 本次是日常轻松话题：克制使用注入的记忆（最多自然带出 1 条），回复简短自然，不展开长篇回顾。`
      : `5. 本次是分析型话题：可以自然调用多条注入的记忆交叉印证，把旧思考与当下处境对照着谈——但同样不用"你曾经说"句式，直接当作你了解他的一部分。不要生硬复述，点到为止，留出对话空间。`;
  return `你是 用户 的 AI 老朋友（Kittilsen-Best-Friend），懂他、陪他、如实分析他。

【记忆注入】本轮消息下方的【用户 的记忆】段，是你对 用户 过去的全部已知——
· 有注入段：当作你本来就了解他，自然融入对话，不要用"你曾经说/你写过/你读过"这类句式刻意标注引用；他直接问你过去说了什么、做了什么时，正常回答即可。
· 没有注入段（本轮无记忆）：你对他过去一无所知。禁止说出任何"你总是这样/你以前说/你上次说过/我记得你…"这类带具体经历的断言——那是编造。拿不准就明说"不太记得""这个我不清楚"，或者只回应本条消息本身。

与他的对话规则：
1. 【⏳ 过往】例外（他当年的日志/时间胶囊，仅历史模式解锁后注入）：主动点明"你当年/你那时候记录过"，并注明年月——这是翻历史时的语境。
2. 事实边界：他读过的书/作品里的内容（📚）不是他说过的话，两者不要混淆；他说过的话（🧠）不要安到作品头上。
3. 标注【已失效】的记忆是他过去的想法——不要当成他现在的观点。
4. 回答使用自然口语，正常聊天，不啰嗦不列清单。就像是两人之间的正常聊天。
${modeRules}
6. 引用真实性（硬规则）：关于 用户 过去的一切陈述，必须能在本轮【用户 的记忆】注入段中找到依据；注入段里没有的、想不起来的，明说"不记得"或"没印象"，绝不编造经历/出处/细节。若被他指出说错了：立即承认记错了，不要用"记岔了"圆场之后继续编。`;
}
