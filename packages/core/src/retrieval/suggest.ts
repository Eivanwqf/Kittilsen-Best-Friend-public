// 记忆建议器：判断用户的长消息是否值得建议写入记忆图书馆（仿 planner.ts 的 chatJson + 校验 + 降级模式）
// 触发门限 SUGGEST_MIN_CHARS（≥80 字才调用 LLM，短消息零成本）；
// 降级契约：永不 reject，任何异常 → { worth: false }，不阻塞对话。
import { chatJson } from '../llm/deepseek.js';

export interface SuggestDecision {
  worth: boolean; // 是否值得建议写入
  title?: string; // 建议标题（≤30 字）
  category?: string; // 建议分类（分类树路径，校验不过则丢弃由用户自选）
  content?: string; // 建议正文（第一人称摘要 ≤300 字，写入时预填 text）
  kind?: string; // 建议类型（6 白名单，校验不过则丢弃）
  validAt?: string; // YYYY-MM-DD，只在用户明确提到时间时给，严禁编造
  reason?: string; // 给用户看的一句话理由（≤20 字）
}

export const SUGGEST_MIN_CHARS = 80;
export const SUGGEST_KINDS = ['experience', 'preference', 'reading_note', 'essay', 'decision', 'principle'];

export async function suggestMemory(
  userMessage: string,
  history: Array<{ role: string; content: string }>,
  validCategories: string[],
): Promise<SuggestDecision> {
  // 当前日期上下文：用户提到月日但没给年份时，LLM 需要据此推断（2026-08-23 曾猜错年份 2024 → 笔记沉底）
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const system = `你是记忆建议器。判断用户消息是否值得建议存入他的个人记忆图书馆（长期保存人生故事、经历、想法、偏好的地方）。
值得建议（worth=true）——核心场景：
- 用户讲述了一段自己的经历/故事/事件，有经过和细节（时间、地点、人物、过程、感受），可独立成条。
- 用户表达了一个明确可记录的偏好、决定、原则或人生感悟。
不值得建议（worth=false）：
- 提问/闲聊/寒暄/天气/时政/技术问题等事实问答。
- 简短回复、衔接语、命令式指令，信息量不足以成为一条独立记忆。
若 worth=true，输出：
- title：≤30 字，概括事件。
- content：用户原话的精炼摘要（第一人称，保留关键细节），≤300 字——将成为记忆正文。
- category：只能从下面分类树里选一个；拿不准 → 省略该字段（不要编造）。
- kind：只能从 ['experience','preference','reading_note','essay','decision','principle'] 里选一个。
- validAt：只在用户明确提到事情发生时间（如"上周""2023年""8月16日"）时输出 YYYY-MM-DD；用户只给月日没给年份时，按今天日期（${today}）推断最近一次（如今天是 2026-08-23，用户说"8月16日" → 2026-08-16）；完全没提时间 → 省略。严禁编造时间或猜错年份。
- reason：给用户看的一句话理由（≤20 字）。
只输出 JSON：{"worth":true,"title":"...","category":"...","content":"...","kind":"...","validAt":"YYYY-MM-DD","reason":"..."}
分类树：${validCategories.join(', ')}`;

  const user =
    history.length > 0
      ? `对话历史：\n${history.slice(-4).map((m) => `${m.role}: ${m.content.slice(0, 200)}`).join('\n')}\n\n当前消息：${userMessage}`
      : `当前消息：${userMessage}`;

  try {
    const resp = await chatJson<SuggestDecision>([{ role: 'system', content: system }, { role: 'user', content: user }], {
      maxTokens: 300,
    });
    if (resp.worth !== true) return { worth: false }; // 严格布尔，防垃圾串误触发
    const valid = new Set(validCategories);
    const category = valid.has(resp.category ?? '') ? resp.category : undefined;
    const kind = SUGGEST_KINDS.includes(resp.kind ?? '') ? resp.kind : undefined;
    const content = (resp.content ?? userMessage).trim().slice(0, 300); // 空则回退用户原话
    const title = (resp.title ?? '').trim().slice(0, 30);
    const validAt = /^\d{4}-\d{2}-\d{2}$/.test(resp.validAt ?? '') ? resp.validAt : undefined;
    const reason = (resp.reason ?? '').trim().slice(0, 20);
    return {
      worth: true,
      ...(title && { title }),
      ...(category && { category }),
      ...(content && { content }),
      ...(kind && { kind }),
      ...(validAt && { validAt }),
      ...(reason && { reason }),
    };
  } catch {
    return { worth: false }; // LLM 挂了 → 不建议，绝不阻塞对话
  }
}
