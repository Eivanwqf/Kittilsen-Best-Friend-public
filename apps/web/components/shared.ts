// 共享纯函数/常量/类型（无 'use client'：server 与 client 组件均可导入）
export interface Note {
  id: number;
  title: string;
  content: string;
  category: string;
  kind: string;
  source_ref: string | null;
  status: string;
  valid_at?: string | null; // 事实生效时间（时间线/排序依据），可空
}

export interface TreeItem {
  path: string;
  parent: string | null;
}

export const KIND_LABEL: Record<string, string> = {
  experience: '经历',
  preference: '偏好',
  reading_note: '读书笔记',
  essay: '随笔',
  decision: '决定',
  principle: '原则',
};

// 档案色板（2026-08-23 前端重构）：铜锈绿=归档 / 低饱和绿=自我 / 铜金=生活方式 / 藏书票红=人生 / 墨绿=知识
export function categoryColor(cat: string): string {
  if (cat === 'archive/journal') return '#5d6b4d';
  if (cat.startsWith('self')) return '#7d9168';
  // lifestyle 以 'life' 开头，必须先判（否则被 life 抢走）
  if (cat.startsWith('lifestyle')) return '#a8863c';
  if (cat.startsWith('life')) return '#b3462e';
  if (cat.startsWith('knowledge')) return '#3f5d54';
  return '#8a8272';
}
