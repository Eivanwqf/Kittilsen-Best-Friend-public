// 检索组合层：planner → 多查询 hybrid → RRF 合并 → 图扩展 → 上下文构建
import type { KbfDb } from '../db/client.js';
import { embedder } from '../embed/embed.js';
import { hybridSearch, type HybridResult } from './hybrid.js';
import { planMemory, type PlannerDecision } from './planner.js';
import { graphExpand } from './graph-expand.js';
import { buildMemoryContext, type BuiltMemory } from './context-builder.js';
import { listCategories } from '../import/categories.js';
import type { NoteRow } from '../notes/notes.js';

export interface MemoryResult {
  decision: PlannerDecision;
  memory: BuiltMemory | null; // null = 零注入
  injectedNotes: NoteRow[]; // 注入的完整笔记（前端 chip 用）
}

const MAX_INJECT = 8;

// #37 前任区：life/relationships/exes（含子路径）
const EX_CATEGORY_PREFIX = 'life/relationships/exes';
const isExCategory = (cat: string) => cat === EX_CATEGORY_PREFIX || cat.startsWith(EX_CATEGORY_PREFIX + '/');
// 与 hybrid 的关系簇正则同源：标题 "第N任相处对象"（getExNames 迁移前兜底）
const RELATION_CLUSTER_RE = /^第[一二三四五六七八九十]+任相处对象/;

// #37 前任人名清单（planner 确定性覆盖用）：实体 join exes 分类笔记；
// 双轨兜底：exes 分类迁移前，实体挂的笔记标题仍匹配簇正则（如"第四任相处对象（attempt1…）"挂实体"attempt1"）
function getExNames(db: KbfDb): string[] {
  const names = new Set<string>();
  const byCat = db
    .prepare(
      `select distinct e.title from entities e
       join notes n on n.entity_id = e.id
       where n.status != 'archived' and n.category like 'life/relationships/exes%'`,
    )
    .all() as Array<{ title: string }>;
  for (const r of byCat) if (r.title) names.add(r.title);
  const all = db
    .prepare(
      `select n.title as noteTitle, e.title as entTitle from entities e
       join notes n on n.entity_id = e.id
       where n.status != 'archived'`,
    )
    .all() as Array<{ noteTitle: string; entTitle: string }>;
  for (const r of all) {
    if (r.entTitle && RELATION_CLUSTER_RE.test(r.noteTitle)) names.add(r.entTitle);
  }
  return [...names];
}

export async function retrieveMemory(
  db: KbfDb,
  userMessage: string,
  history: Array<{ role: string; content: string }>,
): Promise<MemoryResult> {
  const decision = await planMemory(userMessage, history, listCategories(db), getExNames(db));

  if (!decision.needsMemory) {
    return { decision, memory: null, injectedNotes: [] };
  }

  // 多查询混合检索 → 按 RRF 分合并去重
  // 时间窗过滤（2026-08-01）：planner 给出 timeWindow 时检索只留窗口内笔记；
  // 过滤后无结果 → 回退不过滤重跑（窗口过窄/无 valid_at 数据时兜底）
  // 2026-08-22 性能修复：所有查询一次批量 embed（Python 只 spawn 一次）——
  // 此前只 embed 第一个查询，后续查询未传向量导致 hybrid 内部重复 spawn（每条 +4s）
  const qs = decision.queries.filter((q) => q.trim());
  const qvecs = qs.length ? await embedder.embed(qs) : [];
  const vecOf = (q: string) => {
    const i = qs.indexOf(q);
    const v = i >= 0 ? qvecs[i] : undefined;
    return v ? Float32Array.from(v) : undefined;
  };
  const queryVector = vecOf(qs[0] ?? '') ?? undefined; // 图扩展门控用第一个查询向量

  const merged = new Map<number, { hr: HybridResult; best: number }>();
  const runQueries = async (tw?: { from: string; to: string }) => {
    merged.clear();
    for (const q of qs) {
      const results = await hybridSearch(db, q, 8, tw, vecOf(q));
      for (const r of results) {
        const exist = merged.get(r.note.id);
        if (!exist || r.score > exist.best) merged.set(r.note.id, { hr: r, best: r.score });
      }
    }
  };
  await runQueries(decision.timeWindow);
  if (decision.timeWindow && merged.size === 0) await runQueries();

  // #36 注入量分级：analysis 大量注入（8 条 + 图扩展）；casual 克制（top1，不做图扩展）
  const limit = decision.mode === 'casual' ? 1 : MAX_INJECT;
  const top = [...merged.values()]
    .sort((a, b) => b.best - a.best)
    .slice(0, limit)
    .map((m) => m.hr.note);

  // #37 前任区门控（非情感话题排除 exes）：两道过滤——
  // ① 种子过滤（省图扩展开销）；② 扩展后过滤（兜住 2-hop 链接/实体兄弟带出的前任笔记）
  const seeds = decision.emotional ? top : top.filter((n) => !isExCategory(n.category));
  // 图扩展（链接 2-hop + 实体）——语义门控：扩展邻居需与查询相关（2026-08-01）
  const expanded = decision.mode === 'casual' ? seeds : graphExpand(db, seeds, queryVector);
  const final = decision.emotional ? expanded : expanded.filter((n) => !isExCategory(n.category));

  const memory = buildMemoryContext(db, final);
  return { decision, memory, injectedNotes: memory ? final.filter((n) => memory.noteIds.includes(n.id)) : [] };
}
