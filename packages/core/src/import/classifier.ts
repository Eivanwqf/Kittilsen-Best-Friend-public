// LLM 分类器：候选笔记 → 分类树路径 + kind（批量一条 prompt，JSON 模式）
import { chatJson } from '../llm/deepseek.js';
import type { NoteCandidate } from './markdown-parser.js';

export interface ClassifiedCandidate {
  index: number; // 对应候选数组下标
  category: string; // 分类树路径
  kind: 'experience' | 'preference' | 'reading_note' | 'essay' | 'decision' | 'principle';
}

interface ClassifyResponse {
  items: Array<{ index: number; category: string; kind: string }>;
}

const KINDS = ['experience', 'preference', 'reading_note', 'essay', 'decision', 'principle'];

export async function classifyCandidates(
  candidates: NoteCandidate[],
  categories: string[],
): Promise<ClassifiedCandidate[]> {
  if (candidates.length === 0) return [];

  const system = `你是记忆图书馆的图书管理员。把每条笔记放进最合适的书架路径，并从六种笔记类型中选择一种。
书架路径（只能从这些路径里选，不要发明新路径）：
${categories.map((c) => `- ${c}`).join('\n')}
笔记类型（kind）含义：
- experience 亲身经历/事件
- preference 偏好/习惯/口味
- reading_note 读书/观影/听歌的笔记和感悟
- essay 自己写的文章随笔
- decision 做过的重要决定
- principle 边界/原则/价值观
只输出 JSON：{"items":[{"index":0,"category":"书架路径","kind":"类型"}]}，index 对应输入数组下标。`;

  const user = JSON.stringify(
    candidates.map((c, i) => ({ index: i, title: c.title, content: c.content.slice(0, 200) })),
  );

  let resp: ClassifyResponse;
  try {
    resp = await chatJson<ClassifyResponse>([{ role: 'system', content: system }, { role: 'user', content: user }], {
      maxTokens: Math.max(2000, candidates.length * 120), // 每条 items 约 120 token，防截断
    });
  } catch (err) {
    console.error(`[classifier] 降级: ${err instanceof Error ? err.message : err}`);
    return candidates.map((_, i) => ({ index: i, category: 'life/chapters', kind: 'experience' })); // 降级
  }

  // 校验：category 必须是现有路径（只接受最深层），kind 必须合法；否则降级
  const validCategories = new Set(categories);
  const results: ClassifiedCandidate[] = [];
  for (const item of resp.items ?? []) {
    const idx = Number(item.index);
    const cat = item.category ?? '';
    // 容错：LLM 给了父路径也接受（如 self 而非 self/preferences）；非法则降级
    const category = validCategories.has(cat)
      ? cat
      : cat.split('/').slice(0, -1).join('/')
        ? (validCategories.has(cat.split('/').slice(0, -1).join('/')) ? cat.split('/').slice(0, -1).join('/') : 'life/chapters')
        : 'life/chapters';
    const kind = KINDS.includes(item.kind) ? (item.kind as ClassifiedCandidate['kind']) : 'experience';
    results.push({ index: idx, category, kind });
  }
  // 补全缺失下标
  for (let i = 0; i < candidates.length; i++) {
    if (!results.some((r) => r.index === i)) {
      results.push({ index: i, category: 'life/chapters', kind: 'experience' });
    }
  }
  return results.sort((a, b) => a.index - b.index);
}
