// 混合检索：dense（向量 KNN）+ BM25（FTS5 trigram）→ RRF 融合
// 双通道互补：向量抓语义相近，BM25 抓精确专名（中文人名/作品名）
import type { KbfDb } from '../db/client.js';
import { embedder } from '../embed/embed.js';
import { knnSearch } from '../db/vector.js';
import { getNote, type NoteRow } from '../notes/notes.js';

export interface HybridResult {
  note: NoteRow;
  score: number; // RRF 融合分（越高越靠前）
  denseRank: number | null; // dense 通道排名（null=未命中）
  bm25Rank: number | null;
}

const DENSE_TOP = 20;
const BM25_TOP = 20;
const RRF_K = 60; // RRF 标准常数
const FINAL_TOP = 8;
// vec0 默认度量是 L2 欧氏距离（非余弦）。bge-m3 向量已归一化 → L2 = sqrt(2-2cos)。
// 实测（2026-08-01）：相关内容 0.88-0.93，噪音从 0.98 起 → 0.95 门控（≈cos 0.55）。
// 与 importer 演化判定同阈值。
const DENSE_MAX_DISTANCE = 0.95;
// 旧日志降权：archive/journal 是多年以前的记录（2018-2024），检索时得分打折，
// 防止少年时代观点压过当前观点（知识污染防御）；仍可被检索到，保留历史价值
// 0.5 → 0.25（2026-08-01 用户实测：journal 出现频率仍偏高，再降一半）
export const JOURNAL_SCORE_WEIGHT = 0.25;
// 关系簇（第N任相处对象 32-35）：4 条恋爱档案是同主题域，非情感话题也常被 dense 命中
// （人际语义接近"相处对象"）。降权 + 同簇去重（一次最多进 1 条），2026-08-01 用户实测
// 最近 20 条注入 55% 含第N任。
export const RELATION_CLUSTER_RE = /^第[一二三四五六七八九十]+任相处对象/;
export const RELATION_SCORE_WEIGHT = 0.5;

export async function hybridSearch(
  db: KbfDb,
  query: string,
  limit: number = FINAL_TOP,
  timeWindow?: { from: string; to: string }, // planner 时间窗（YYYY-MM）：只保留 valid_at 在窗口内的笔记
  queryVector?: Float32Array, // 复用外部已嵌入的查询向量（图扩展门控共用，省一次 spawn）
): Promise<HybridResult[]> {
  const rankMap = new Map<number, { dense: number | null; bm25: number | null }>();

  // ── 通道 1：dense（向量相似度，distance < 0.5 门控滤掉弱相关噪音）──
  if (!queryVector) {
    const [vec] = await embedder.embed([query]);
    queryVector = Float32Array.from(vec!); // embed 必有返回
  }
  const denseHits = knnSearch(db, queryVector, DENSE_TOP).filter((h) => h.distance < DENSE_MAX_DISTANCE);
  denseHits.forEach((h, i) => {
    const entry = rankMap.get(h.noteId) ?? { dense: null, bm25: null };
    entry.dense = i + 1;
    rankMap.set(h.noteId, entry);
  });

  // ── 通道 2：BM25（FTS5 trigram，≥3 字符才有效）──
  // 注意：FTS5 的 match 必须用位置参数 ?，命名参数（@q）会静默返回空
  if (query.trim().length >= 3) {
    // FTS5 列名注入防护（2026-08-01 实测 500）：以数字开头的 bareword（"2023"）会被解析为列名
    // → no such column: 2023。数字开头的 token 双引号短语化；查询失败降级跳过 BM25（LIKE 通道仍在）
    const ftsQuery = query
      .split(/\s+/)
      .map((t) => (/^\d/.test(t) ? `"${t.replace(/"/g, '""')}"` : t))
      .join(' ');
    let rows: Array<{ rowid: number }> = [];
    try {
      rows = db
        .prepare(
          `select rowid from notes_fts
           where notes_fts match ?
           order by bm25(notes_fts, 1.0, 1.0, 1.0)
           limit ${BM25_TOP}`,
        )
        .all(ftsQuery) as Array<{ rowid: number }>;
    } catch {
      rows = []; // FTS 解析异常 → 跳过本通道，不阻断检索
    }
    rows.forEach((r, i) => {
      const entry = rankMap.get(r.rowid) ?? { dense: null, bm25: null };
      entry.bm25 = i + 1;
      rankMap.set(r.rowid, entry);
    });
  }

  // ── 通道 3：专名 LIKE 兜底（2 字人名/作品名 trigram 覆盖不了，如 attempt1 这类短名）──
  const likeHits = db
    .prepare(`select id from notes where status != 'archived' and (title like ? or content like ?) limit ${BM25_TOP}`)
    .all(`%${query}%`, `%${query}%`) as Array<{ id: number }>;
  likeHits.forEach((r, i) => {
    const entry = rankMap.get(r.id) ?? { dense: null, bm25: null };
    // 与 BM25 同权重（0.5）：专名精确命中价值高
    entry.bm25 = entry.bm25 ?? i + 1;
    rankMap.set(r.id, entry);
  });

  // ── 通道 4：实体名匹配（人名/作品名在 entities 表，不在笔记文本里——attempt2）──
  // 双向 LIKE：e.title 含查询词（attempt2），或查询词含 e.title（"attempt2 是谁"）
  // —— planner 查询有波动，只单向匹配会漏（2026-08-01 e2e 实测：注入 4→3 条）
  const entHits = db
    .prepare(
      `select n.id from entities e
       join notes n on n.entity_id = e.id
       where (e.title like ? or ? like '%' || e.title || '%') and n.status != 'archived'
       limit ${BM25_TOP}`,
    )
    .all(`%${query}%`, query) as Array<{ id: number }>;
  entHits.forEach((r, i) => {
    const entry = rankMap.get(r.id) ?? { dense: null, bm25: null };
    entry.bm25 = entry.bm25 ?? i + 1;
    rankMap.set(r.id, entry);
  });

  // ── RRF 融合 ──
  const results: HybridResult[] = [];
  for (const [noteId, ranks] of rankMap) {
    const note = getNote(db, noteId);
    if (!note || note.status === 'archived') continue;
    // 时间窗过滤：无 valid_at 的笔记不参与时间精确匹配（M2 遗留，2026-08-01 实现）
    if (timeWindow) {
      const vm = note.valid_at?.slice(0, 7) ?? '';
      if (!vm || vm < timeWindow.from || vm > timeWindow.to) continue;
    }
    let score = 0;
    if (ranks.dense !== null) score += 1 / (RRF_K + ranks.dense);
    if (ranks.bm25 !== null) score += 1 / (RRF_K + ranks.bm25);
    // 旧日志降权（防知识污染）
    if (note.category === 'archive/journal') score *= JOURNAL_SCORE_WEIGHT;
    // 关系簇降权（第N任相处对象）：非情感话题不让 4 条档案占位
    if (RELATION_CLUSTER_RE.test(note.title)) score *= RELATION_SCORE_WEIGHT;
    results.push({ note, score, denseRank: ranks.dense, bm25Rank: ranks.bm25 });
  }
  // 同簇去重：第N任相处对象只保留簇内最高分 1 条（问"第二任"→33 进；泛人际话题不再 4 条齐上）
  const sorted = results.sort((a, b) => b.score - a.score);
  let clusterKept = false;
  const deduped: HybridResult[] = [];
  for (const r of sorted) {
    if (RELATION_CLUSTER_RE.test(r.note.title)) {
      if (clusterKept) continue;
      clusterKept = true;
    }
    deduped.push(r);
  }
  return deduped.slice(0, limit);
}
