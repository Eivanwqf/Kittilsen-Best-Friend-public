// 首页 = 记忆图书馆（服务端渲染，直接读 Fastify API；筛选/写入在 Library 客户端组件）
import { Library } from '../components/library';
import type { Note, TreeItem } from '../components/shared';

const API = 'http://localhost:8899';

async function fetchNotes(): Promise<{ total: number; rows: Note[] }> {
  try {
    const res = await fetch(`${API}/api/notes?limit=200`, { cache: 'no-store' });
    if (!res.ok) return { total: 0, rows: [] };
    return await res.json();
  } catch {
    return { total: 0, rows: [] };
  }
}

async function fetchCategories(): Promise<TreeItem[]> {
  try {
    const res = await fetch(`${API}/api/categories`, { cache: 'no-store' });
    if (!res.ok) return [];
    return (await res.json()).tree ?? [];
  } catch {
    return [];
  }
}

export default async function Home() {
  const { total, rows } = await fetchNotes();
  const tree = await fetchCategories();

  return (
    <main className="page">
      <header className="page-head rise">
        <div className="page-title">
          <span className="seal">KBF</span>
          <span>记忆图书馆</span>
        </div>
        <p className="page-sub">
          灵感来源于村上春树写道的"我们每个人内心都有着一个图书馆，存放着自己经历过的事情。"当前你自己的书架，馆藏 {total} 卷。
          <span style={{ display: 'block', marginTop: 6, color: 'var(--ink-4)', fontSize: 12 }}>Proudly made by Eivanwqf.</span>
        </p>
      </header>

      {/* 始终渲染 Library：空态也显示"✍️ 记下来"入口（2026-08-08 全量重置后从零录入） */}
      <Library notes={rows} tree={tree} total={total} />
      {total === 0 && <p style={{ color: '#9a9181', marginTop: 24 }}>还没有记忆——点左侧「✍️ 记下来」写下第一条。</p>}
    </main>
  );
}
