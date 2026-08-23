// 记忆规划器：LLM 判断本轮是否需要记忆 + 生成查询（~200 token，JSON 模式）
// needsMemory=false → 调用方直接短路，零检索开销（省成本）
import { chatJson } from '../llm/deepseek.js';

export interface PlannerDecision {
  needsMemory: boolean;
  queries: string[]; // 1-3 条查询：混合关键词式（BM25 友好）与语义式（dense 友好）
  timeWindow?: { from: string; to: string }; // 可选时间窗（YYYY-MM）
  categories?: string[]; // 可选分类限定（书架路径）
  mode: 'analysis' | 'casual'; // #36 场景分级：分析型大量注入+呼应式；日常型克制引用（≤1 条）
  emotional: boolean; // #37 前任区门控：false → 检索排除 life/relationships/exes
}

// 降级：保守查一次（空查询 → dense 检索当前消息本身），不排除前任区
const FALLBACK: PlannerDecision = { needsMemory: true, queries: [''], mode: 'casual', emotional: true };

const MONTH_RE = /^\d{4}-\d{2}$/;
// 与 hybrid 的关系簇正则同源：消息含"第N任" → 前任话题（确定性覆盖，不依赖 LLM 情感判定）
const RELATION_QUERY_RE = /第[一二三四五六七八九十]+任/;

export async function planMemory(
  userMessage: string,
  history: Array<{ role: string; content: string }>,
  validCategories?: string[],
  exNames?: string[],
): Promise<PlannerDecision> {
  const system = `你是记忆规划器。判断用户消息是否需要读取他的个人记忆库（人生经历、偏好、读书笔记、原则、健身财务等个人档案）。
需要记忆的情况：问个人经历/偏好/想法、提到认识的人/读过的书/过去的自己、需要个性化回应的内容。
不需要记忆的情况：纯闲聊（打招呼/天气/时政/技术问题/菜谱等与个人档案无关）、纯事实问答、游戏攻略等。
强制规则：
- 消息里出现人名（中文名/昵称/外号）时，除非能确定是公众人物（明星/名人/历史人物），否则**必须** needsMemory=true——这个人很可能是他生活中的人（前任/家人/朋友），"X是谁"也要查。
- 出现作品名（书/电影/游戏/歌曲）时也必须 needsMemory=true。
如果需要，生成 1-3 条检索查询：
- 至少一条是"关键词式"（人名/书名/专名或核心名词，利于精确匹配）
- 至少一条是"语义式"（完整问句或描述，利于语义相似）
只输出 JSON：{"needsMemory":true,"queries":["..."],"mode":"casual","emotional":true,"timeWindow":{"from":"YYYY-MM","to":"YYYY-MM"},"categories":["书架路径"]}。
额外输出：
- mode：'analysis'（性格/心理/自我剖析/成长反思/读书笔记与当下对照类深度话题）或 'casual'（事实查询/日常话题/简单问询）。拿不准 → casual。
- emotional：布尔。消息涉及恋爱/前任/亲密关系（前任人名、"第N任"、分手、感情经历）→ true；纯功能话题（健身/财务/技术/天气/工作）→ false。
已知前任相关人名：${exNames?.join('、') ?? '（无）'}——消息提到其中任意一个，emotional 必须为 true。
严格规则：
- timeWindow 只在用户消息明确提到时间（如"2018年""高三时"）才给，否则省略。严禁编造时间。
- categories 只能从提供的书架路径列表里选，只能选列表里存在的路径。
书架路径列表：${validCategories?.join(', ') ?? '（未提供）'}`;

  const user = history.length > 0
    ? `对话历史：\n${history.slice(-4).map((m) => `${m.role}: ${m.content.slice(0, 200)}`).join('\n')}\n\n当前消息：${userMessage}`
    : `当前消息：${userMessage}`;

  try {
    const resp = await chatJson<PlannerDecision>([{ role: 'system', content: system }, { role: 'user', content: user }], {
      maxTokens: 300,
    });
    const queries = (resp.queries ?? []).filter((q) => q && q.trim().length >= 2).slice(0, 3);
    // 校验：timeWindow 格式 + 合法性；categories 必须存在于书架路径
    const tw = resp.timeWindow;
    const timeWindow =
      tw && MONTH_RE.test(tw.from ?? '') && MONTH_RE.test(tw.to ?? '') && tw.from! <= tw.to! ? tw : undefined;
    const valid = new Set(validCategories ?? []);
    const categories = (resp.categories ?? []).filter((c) => valid.has(c)).slice(0, 3);
    // #37 确定性覆盖：提到前任人名/"第N任" → 强制 emotional=true + needsMemory=true
    // 不依赖 LLM 情感判定稳定性（防"attempt1 是谁？"这类查询被误排除）
    // exName 守卫：≥2 字符，且（≥3 字符 或 含汉字）——排除 2 字符 ASCII 短名实体的 substring 误伤
    const exList = (exNames ?? []).filter((n) => n && n.length >= 2 && (n.length >= 3 || /[一-鿿]/.test(n)));
    const mentionsEx = exList.some((n) => userMessage.includes(n)) || RELATION_QUERY_RE.test(userMessage);
    return {
      needsMemory: (!!resp.needsMemory && queries.length > 0) || mentionsEx,
      queries: queries.length ? queries : [''],
      timeWindow,
      categories: categories.length ? categories : undefined,
      mode: resp.mode === 'analysis' ? 'analysis' : 'casual',
      emotional: (typeof resp.emotional === 'boolean' ? resp.emotional : true) || mentionsEx,
    };
  } catch {
    return FALLBACK; // 降级：保守查一次（空查询 → dense 检索当前消息本身）
  }
}
