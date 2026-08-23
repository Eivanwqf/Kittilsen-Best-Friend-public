// 分类树：书架路径（数据驱动，LLM 只从现有路径选，不凭空造）
export const CATEGORY_TREE: Array<{ path: string; parent: string | null }> = [
  // 人生经历
  { path: 'life', parent: null },
  { path: 'life/chapters', parent: 'life' }, // 生活章节（实习、高三…）
  { path: 'life/events', parent: 'life' }, // 具体事件
  { path: 'life/relationships', parent: 'life' }, // 关系
  { path: 'life/relationships/exes', parent: 'life/relationships' }, // 前任区（emotional 门控排除）
  // 注意：archive/journal 不在分类树（归档内容退出活跃分类体系，见 journal-mode.ts）
  // 自我
  { path: 'self', parent: null },
  { path: 'self/persona', parent: 'self' }, // 人格画像
  { path: 'self/preferences', parent: 'self' }, // 偏好
  { path: 'self/emotions', parent: 'self' }, // 情绪
  { path: 'self/decisions', parent: 'self' }, // 决定
  { path: 'self/principles', parent: 'self' }, // 边界原则
  // 知识
  { path: 'knowledge', parent: null },
  { path: 'knowledge/books', parent: 'knowledge' }, // 书目
  { path: 'knowledge/reading-notes', parent: 'knowledge' }, // 读书笔记
  { path: 'knowledge/essays', parent: 'knowledge' }, // 文章随笔
  { path: 'knowledge/concepts', parent: 'knowledge' }, // 概念观点
  // 生活
  { path: 'lifestyle', parent: null },
  { path: 'lifestyle/health', parent: 'lifestyle' }, // 健身作息
  { path: 'lifestyle/finance', parent: 'lifestyle' }, // 财务
  { path: 'lifestyle/skills', parent: 'lifestyle' }, // 技能
];

export function seedCategories(db: import('../db/client.js').KbfDb): void {
  const ins = db.prepare('insert or ignore into categories(path, parent) values (?, ?)');
  for (const c of CATEGORY_TREE) ins.run(c.path, c.parent);
}

export function listCategories(db: import('../db/client.js').KbfDb): string[] {
  return (db.prepare('select path from categories order by path').all() as Array<{ path: string }>).map((r) => r.path);
}
