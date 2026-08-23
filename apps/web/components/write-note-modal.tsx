// "记下来"弹窗：单条原子记忆写入（LLM 分类 + 向量化 + 演化判定，约 5-10 秒）
// 2026-08-23 从 library.tsx 提取为共享组件：图书馆"记下来"与对话建议卡片确认共用；
// initial 预填（建议卡片传入 LLM 生成的 title/category/kind/content/validAt）；source 区分写入入口
// 2026-08-23 前端重构：档案弹窗视觉（羊皮纸卡 + 印章红按钮）
'use client';
import { useState } from 'react';
import { KIND_LABEL, type TreeItem } from './shared';

// 今天（本地时区 YYYY-MM-DD，不用 toISOString 避免 UTC 偏移一天）
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function WriteNoteModal({
  tree,
  onClose,
  onSaved,
  initial,
  source = 'manual',
}: {
  tree: TreeItem[];
  onClose: () => void;
  onSaved: () => void;
  initial?: Partial<{ text: string; title: string; category: string; kind: string; validAt: string }>;
  source?: 'chat' | 'manual';
}) {
  const [text, setText] = useState(initial?.text ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [category, setCategory] = useState(initial?.category ?? '');
  const [kind, setKind] = useState(initial?.kind ?? '');
  const [validAt, setValidAt] = useState(initial?.validAt ?? todayStr()); // 默认今天
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const paths = tree.map((t) => t.path);
  const kinds = ['experience', 'preference', 'reading_note', 'essay', 'decision', 'principle'];

  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text.trim(),
          title: title.trim() || undefined,
          category: category || undefined,
          kind: kind || undefined,
          valid_at: validAt || undefined,
          source,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? '写入失败');
        return;
      }
      onSaved();
    } catch {
      setError('请求失败，请确认 server 已启动');
    } finally {
      setBusy(false);
    }
  };

  return (
    // 2026-08-08：遮罩不再响应点击关闭——只有"取消"按钮关闭（防误触丢失未保存内容）
    <div className="modal-overlay">
      <div className="modal-card">
        <h3 className="modal-title">✍️ 记下来{source === 'chat' && <span style={{ fontSize: 12.5, color: '#9a9181', marginLeft: 8, fontFamily: 'var(--font-sans)' }}>（来自对话建议）</span>}</h3>
        <p className="modal-sub">单条原子记忆（≤300 字），自动分类 + 演化判定</p>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="今天发生了什么 / 想到了什么……"
          maxLength={300}
          rows={4}
          className="textarea"
          style={{ width: '100%', boxSizing: 'border-box' }}
        />
        <div style={{ textAlign: 'right', color: text.length > 280 ? '#b3462e' : '#9a9181', fontSize: 12, marginTop: 4 }}>
          {text.length}/300
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="标题（可选，默认取前 20 字）"
            className="input"
            style={{ fontFamily: 'var(--font-serif)' }}
          />
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="select">
            <option value="">类型（自动判定）</option>
            {kinds.map((k) => (
              <option key={k} value={k}>{KIND_LABEL[k] ?? k}</option>
            ))}
          </select>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="select">
            <option value="">分类（自动判定）</option>
            {paths.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <input
            type="date"
            value={validAt}
            onChange={(e) => setValidAt(e.target.value)}
            title="有效时间（事情发生的时间），默认今天"
            className="input"
          />
        </div>

        {error && <p style={{ color: '#b3462e', fontSize: 13, margin: '10px 0 0' }}>{error}</p>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
          <button onClick={onClose} disabled={busy} className="btn">
            取消
          </button>
          <button onClick={submit} disabled={busy || !text.trim()} className="btn btn-primary">
            {busy ? '正在写入…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
