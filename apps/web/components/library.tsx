// 记忆图书馆（客户端）：分类树导航 + 筛选列表 + "记下来"写入弹窗
// 2026-08-23 前端重构：索引卡风格（档案编号 + 分类印章 + 衬线标题）
'use client';
import { useState } from 'react';
import { KIND_LABEL, categoryColor, type Note, type TreeItem } from './shared';
import { WriteNoteModal } from './write-note-modal';

// 与后端子树匹配一致：选中 'self' → category === 'self' 或 startsWith('self/')
function matches(selected: string, category: string): boolean {
  return category === selected || category.startsWith(selected + '/');
}

// 档案编号：NO.xxxxx（补零，来源 note.id）
const serial = (id: number) => `NO.${String(id).padStart(5, '0')}`;

export function Library({ notes, tree, total }: { notes: Note[]; tree: TreeItem[]; total: number }) {
  const [selected, setSelected] = useState('');
  const [showWrite, setShowWrite] = useState(false);

  // 分类树 → 层级结构（parent → children）
  const childrenOf = new Map<string, TreeItem[]>();
  for (const item of tree) {
    const p = item.parent ?? '';
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p)!.push(item);
  }

  const countFor = (path: string) => (path === '' ? total : notes.filter((n) => matches(path, n.category)).length);
  const filtered = selected === '' ? notes : notes.filter((n) => matches(selected, n.category));

  const renderNode = (item: TreeItem, depth: number) => {
    const kids = childrenOf.get(item.path) ?? [];
    const count = countFor(item.path);
    if (count === 0) return null; // 空分类不展示
    const active = selected === item.path;
    return (
      <div key={item.path}>
        <button
          onClick={() => setSelected(active ? '' : item.path)}
          className={`side-item${active ? ' active' : ''}`}
          style={{ display: 'flex', alignItems: 'center', gap: 7, paddingLeft: 12 + depth * 14 }}
        >
          {/* 分类色点：菱形 + 深色描边（米底上更清晰） */}
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: 2,
              background: categoryColor(item.path),
              flexShrink: 0,
              transform: 'rotate(45deg)',
              boxShadow: '0 0 0 1.5px rgba(43,38,32,0.22)',
            }}
          />
          <span style={{ letterSpacing: '0.04em' }}>{item.path.split('/').pop()}</span>
          <span style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.65 }}>{count}</span>
        </button>
        {kids.map((k) => renderNode(k, depth + 1))}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', gap: 26, alignItems: 'flex-start' }}>
      {/* 左侧分类树（档案抽屉） */}
      <aside className="side-panel" style={{ width: 200, flexShrink: 0, position: 'sticky', top: 72, padding: 10 }}>
        <button
          onClick={() => setSelected('')}
          className={`side-item${selected === '' ? ' active' : ''}`}
          style={{ display: 'flex', alignItems: 'center', gap: 7 }}
        >
          <span className="serial">全部</span>
          <span style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.65 }}>{total}</span>
        </button>
        {(childrenOf.get('') ?? []).map((root) => renderNode(root, 0))}
        <button onClick={() => setShowWrite(true)} className="btn btn-primary" style={{ marginTop: 14, width: '100%' }}>
          ✍️ 记下来
        </button>
      </aside>

      {/* 右侧笔记列表（索引卡） */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ margin: 0, color: '#9a9181', fontSize: 12.5, letterSpacing: '0.05em' }}>
          {selected === '' ? '全部馆藏' : selected} · {filtered.length} 卷
        </p>
        {filtered.map((n, i) => (
          <a
            key={n.id}
            href={`/notes/${n.id}`}
            className="card card-hover rise"
            style={{ padding: '14px 18px', textDecoration: 'none', color: 'inherit', display: 'block', animationDelay: `${Math.min(i, 12) * 35}ms` }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7, flexWrap: 'wrap' }}>
              <span className="tag" style={{ background: categoryColor(n.category) }}>
                {n.category.split('/').pop()}
              </span>
              <span style={{ color: '#655d4f', fontSize: 12 }}>{KIND_LABEL[n.kind] ?? n.kind}</span>
              <span style={{ color: '#9a9181', fontSize: 12 }}>📅 {n.valid_at?.slice(0, 10) ?? '时间未知'}</span>
              {n.status === 'superseded' && <span className="tag ghost">已失效</span>}
              <span className="serial" style={{ marginLeft: 'auto' }}>{serial(n.id)}</span>
            </div>
            <h3
              style={{
                margin: 0,
                fontSize: 16,
                fontFamily: 'var(--font-serif)',
                fontWeight: 700,
                letterSpacing: '0.03em',
                textDecoration: n.status === 'superseded' ? 'line-through' : 'none',
              }}
            >
              {n.title}
            </h3>
            <p style={{ margin: '6px 0 0', color: '#655d4f', fontSize: 13.5, lineHeight: 1.75 }}>{n.content}</p>
            {n.source_ref && <div style={{ marginTop: 8, fontSize: 11, color: '#c2b9a6', letterSpacing: '0.06em' }}>来源 · {n.source_ref}</div>}
          </a>
        ))}
        {filtered.length === 0 && <p style={{ color: '#9a9181' }}>该分类下没有笔记。</p>}
      </div>

      {showWrite && <WriteNoteModal tree={tree} onClose={() => setShowWrite(false)} onSaved={() => window.location.reload()} />}
    </div>
  );
}
