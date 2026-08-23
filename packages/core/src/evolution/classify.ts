// A-MEM 演化判定：候选笔记 vs top-3 相关现有笔记 → NEW/EXPAND/CONFLICT/EVOLVE
// 硬规则：experience（历史经历）和 reading_note（阅读快照）永不失效——只有观点/原则/偏好会演化
// 判定失败默认 NEW（降级不阻塞导入）
import { chatJson } from '../llm/deepseek.js';
import type { NoteRow } from '../notes/notes.js';

export type EvolutionType = 'NEW' | 'EXPAND' | 'CONFLICT' | 'EVOLVE';

export interface EvolutionDecision {
  type: EvolutionType;
  reason: string; // 人话，UI 直接展示
  relatedNoteIds: number[]; // 相关现有笔记 id（EXPAND/CONFLICT/EVOLVE 时非空）
  supersedeNoteIds: number[]; // 明确要取代的笔记 id（只有这些会被标失效）
}

interface EvolutionResponse {
  type?: string;
  reason?: string;
  relatedIndexes?: number[];
  supersedesIndexes?: number[]; // EVOLVE 时显式指出取代哪几条
}

// 永不失效的 kind：历史事实和阅读快照不可被取代
const NEVER_SUPERSEDE: ReadonlySet<string> = new Set(['experience', 'reading_note']);

export function canBeSuperseded(note: Pick<NoteRow, 'kind' | 'source' | 'title' | 'source_ref'>): boolean {
  if (NEVER_SUPERSEDE.has(note.kind)) return false;
  // 概要笔记（导入切片中 title === source_ref 的文件简介）只是元信息，不是观点，不可作为取代目标
  if (note.source === 'import' && note.title === note.source_ref) return false;
  return true;
}

export async function classifyEvolution(
  title: string,
  content: string,
  related: NoteRow[],
): Promise<EvolutionDecision> {
  if (related.length === 0) return { type: 'NEW', reason: '库中没有相关笔记，作为新事实入库', relatedNoteIds: [], supersedeNoteIds: [] };

  const system = `你是记忆演化分析器。判断一条新笔记与现有相关笔记的关系，四种类型：
- NEW：与现有笔记无关或关系很弱，是全新事实
- EXPAND：补充、细化、例证了现有笔记的内容（不取代）
- CONFLICT：与现有笔记直接矛盾（新旧观点对立，如 2022 年观点 vs 2026 年观点）
- EVOLVE：新观点**明确取代**旧观点（同一主题的发展/升级/内化）
严格规则：
1. 历史经历（kind=experience）和阅读快照（kind=reading_note）**永不被取代**——发生过的事、读过的书的想法是历史事实，只可补充(EXPAND)、不可失效。给它们标 EVOLVE 是错误。
2. EVOLVE 只有在"旧观点确实被新观点取代"时才选——仅仅主题相关、时间更晚、后来写了总结，都不构成取代（如：健身计划 vs 健身记录是互补，不是取代；具体经历 vs 人生总结不是取代）。
3. EVOLVE 时用 supersedesIndexes 显式列出被取代的笔记下标（通常 1 条），没有明确取代对象的不要选 EVOLVE。
4. 不确定时选 EXPAND 而不是 EVOLVE。
只输出 JSON：{"type":"NEW|EXPAND|CONFLICT|EVOLVE","reason":"一句人话","relatedIndexes":[下标],"supersedesIndexes":[下标]}。`;

  const user = `新笔记：${title}\n${content.slice(0, 200)}
现有相关笔记：
${related.map((r, i) => `[${i}] ${r.title}（${r.valid_at ?? '时间未知'}，kind=${r.kind}）：${r.content.slice(0, 120)}`).join('\n')}`;

  try {
    const resp = await chatJson<EvolutionResponse>(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      { maxTokens: 300 },
    );
    const type = (resp.type ?? 'NEW') as EvolutionType;
    const valid = ['NEW', 'EXPAND', 'CONFLICT', 'EVOLVE'];
    const relatedNoteIds = (resp.relatedIndexes ?? [])
      .map((i) => related[Number(i)])
      .filter(Boolean)
      .map((r) => (r as NoteRow).id);
    // 取代目标：LLM 显式指定 + 旧笔记 kind 允许被取代（experience/reading_note 自动排除）
    const supersedeNoteIds = (resp.supersedesIndexes ?? [])
      .map((i) => related[Number(i)])
      .filter((n): n is NoteRow => !!n && canBeSuperseded(n))
      .map((n) => n.id);
    // EVOLVE 但没明确取代对象 → 降级 EXPAND（防误失效）
    const finalType: EvolutionType =
      type === 'EVOLVE' && supersedeNoteIds.length === 0 ? 'EXPAND' : type;
    return {
      type: valid.includes(finalType) ? finalType : 'NEW',
      reason: resp.reason?.trim() || '（无理由）',
      relatedNoteIds,
      supersedeNoteIds,
    };
  } catch {
    return { type: 'NEW', reason: '演化判定失败，降级为新笔记', relatedNoteIds: [], supersedeNoteIds: [] };
  }
}
