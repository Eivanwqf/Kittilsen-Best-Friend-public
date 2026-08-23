'use client';

// M3 演化闭环：笔记详情页 + EvolutionChain（演化链可视化）
// 数据来自 GET /api/notes/:id 聚合接口：本体 + 实体 + 演化事件 + 前驱/后继 + 相关链接
import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';

interface Detail {
  note: {
    id: number;
    uid: string;
    title: string;
    content: string;
    category: string;
    kind: string;
    tags: string;
    valid_at: string | null;
    confidence: number;
    source: string;
    source_ref: string | null;
    status: string;
    superseded_by: number | null;
    access_count: number;
    entity_id: number | null;
    created_at: string;
  };
  entity: { id: number; type: string; title: string; creator: string | null; year: number | null } | null;
  evolution: Array<{ id: number; type: string; reason: string; created_at: string; prevTitle: string | null; nextTitle: string | null }>;
  predecessors: Array<{ id: number; uid: string; title: string; valid_at: string | null; kind: string }>;
  successor: { id: number; uid: string; title: string } | null;
  related: Array<{ id: number; uid: string; title: string; status: string; kind: string }>;
}

interface EvoBadge {
  bg: string;
  color: string;
  label: string;
}
// 档案演化徽标（2026-08-23 重构：墨绿=新建 / 铜金=扩展 / 藏书票红=冲突 / 深棕=演化）
const EVO_STYLE: Record<string, EvoBadge> = {
  NEW: { bg: '#e3e7dc', color: '#3f5d54', label: 'NEW 新建' },
  EXPAND: { bg: '#efe6cf', color: '#8a6d23', label: 'EXPAND 扩展' },
  CONFLICT: { bg: '#f0ded5', color: '#8e3520', label: 'CONFLICT 冲突' },
  EVOLVE: { bg: '#e8e0d2', color: '#7a6a4f', label: 'EVOLVE 演化' },
};
const EVO_FALLBACK: EvoBadge = { bg: '#f8f3e7', color: '#9a9181', label: '—' };
function evoStyleOf(type: string): EvoBadge {
  return EVO_STYLE[type] ?? EVO_FALLBACK;
}
const KIND_LABEL: Record<string, string> = {
  experience: '经历',
  reading_note: '读书笔记',
  essay: '随笔',
  preference: '偏好',
  decision: '决定',
  principle: '原则',
};
const ENTITY_TYPE_LABEL: Record<string, string> = {
  book: '📚 书',
  movie: '🎬 影',
  music: '🎵 音乐',
  game: '🎮 游戏',
  person: '🧠 人',
  place: '📍 地点',
};

function Badge({ bg, color, children }: { bg: string; color: string; children: React.ReactNode }) {
  return (
    <span
      className="badge"
      style={{
        background: bg,
        color,
        fontWeight: 500,
      }}
    >
      {children}
    </span>
  );
}

// 记忆编辑弹窗（2026-08-05 核心需求）：逐条修正标题/内容/分类/类型/有效时间
// 只提交变更字段（避免无谓的向量重算）；content/title 变更由 server 重算向量
function EditModal({
  note,
  tree,
  onClose,
  onSaved,
}: {
  note: Detail['note'];
  tree: Array<{ path: string; parent: string | null }>;
  onClose: () => void;
  onSaved: (d: Detail) => void;
}) {
  const [form, setForm] = useState({
    title: note.title,
    content: note.content,
    category: note.category,
    kind: note.kind,
    valid_at: note.valid_at ?? '',
  });
  const [entityId, setEntityId] = useState<number | null>(note.entity_id); // 2026-08-08 实体手动化
  const [entities, setEntities] = useState<Array<{ id: number; type: string; title: string }>>([]);
  const [showNew, setShowNew] = useState(false);
  const [newType, setNewType] = useState('book');
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const kinds = ['experience', 'preference', 'reading_note', 'essay', 'decision', 'principle'];
  const entityTypes = ['book', 'movie', 'music', 'game', 'place', 'person'];
  const paths = tree.map((t) => t.path);
  const set = (k: 'title' | 'content' | 'category' | 'kind' | 'valid_at', v: string) => setForm((f) => ({ ...f, [k]: v }));

  // 实体列表（挂载下拉用）
  useEffect(() => {
    fetch('/api/entities')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setEntities(d.entities ?? []))
      .catch(() => {});
  }, []);

  // 新建实体并挂载
  const createNew = async () => {
    if (!newTitle.trim() || busy) return;
    try {
      const res = await fetch('/api/entities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: newType, title: newTitle.trim() }),
      });
      const d = await res.json();
      if (!res.ok) {
        setError(d.error ?? '创建失败');
        return;
      }
      setEntities((es) => [...es, { id: d.id, type: d.type, title: d.title }]);
      setEntityId(d.id);
      setNewTitle('');
      setShowNew(false);
    } catch {
      setError('创建实体失败');
    }
  };

  const save = async () => {
    if (busy) return;
    if (!form.title.trim() || !form.content.trim()) {
      setError('标题和内容不能为空');
      return;
    }
    const body: Record<string, unknown> = {};
    if (form.title.trim() !== note.title) body.title = form.title.trim();
    if (form.content.trim() !== note.content) body.content = form.content.trim();
    if (form.category !== note.category) body.category = form.category;
    if (form.kind !== note.kind) body.kind = form.kind;
    const va = form.valid_at || null;
    if (va !== note.valid_at) body.valid_at = va;
    if (entityId !== note.entity_id) body.entity_id = entityId;
    if (!Object.keys(body).length) {
      onClose();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/notes/${note.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? '保存失败');
        return;
      }
      onSaved(data as Detail);
    } catch {
      setError('请求失败，请确认 server 已启动');
    } finally {
      setBusy(false);
    }
  };

  return (
    // 2026-08-08：遮罩不再响应点击关闭——只有"取消"按钮关闭（防误触丢失编辑内容）
    <div className="modal-overlay">
      <div className="modal-card">
        <h3 className="modal-title">✏️ 编辑记忆</h3>
        <p className="modal-sub">修改内容或标题会重算向量（约 2-3 秒）；修正有效时间可更新时间线</p>

        <label style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>标题</label>
        <input
          value={form.title}
          onChange={(e) => set('title', e.target.value)}
          maxLength={100}
          className="input"
          style={{ width: '100%', boxSizing: 'border-box', margin: '4px 0 12px', fontFamily: 'var(--font-serif)' }}
        />

        <label style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>内容（≤300 字）</label>
        <textarea
          value={form.content}
          onChange={(e) => set('content', e.target.value)}
          maxLength={300}
          rows={6}
          className="textarea"
          style={{ width: '100%', boxSizing: 'border-box', margin: '4px 0 0' }}
        />
        <div style={{ textAlign: 'right', color: form.content.length > 280 ? 'var(--seal)' : 'var(--ink-3)', fontSize: 12, margin: '2px 0 12px' }}>
          {form.content.length}/300
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <div>
            <label style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>分类</label>
            <select value={form.category} onChange={(e) => set('category', e.target.value)} className="select" style={{ width: '100%', marginTop: 4 }}>
              {paths.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>类型</label>
            <select value={form.kind} onChange={(e) => set('kind', e.target.value)} className="select" style={{ width: '100%', marginTop: 4 }}>
              {kinds.map((k) => (
                <option key={k} value={k}>{KIND_LABEL[k] ?? k}</option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
          <div>
            <label style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>有效时间（时间线依据）</label>
            <input
              type="date"
              value={form.valid_at}
              onChange={(e) => set('valid_at', e.target.value)}
              className="input"
              style={{ display: 'block', marginTop: 4 }}
            />
          </div>
          {form.valid_at && (
            <button onClick={() => set('valid_at', '')} className="btn" style={{ padding: '7px 12px' }}>
              清除时间
            </button>
          )}
        </div>

        <div style={{ marginTop: 14 }}>
          <label style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>关联实体（影响身份前缀 📚/🧠 与实体检索）</label>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <select
              value={entityId ?? ''}
              onChange={(e) => setEntityId(e.target.value ? Number(e.target.value) : null)}
              className="select"
              style={{ flex: 1 }}
            >
              <option value="">无实体</option>
              {entities.map((ent) => (
                <option key={ent.id} value={ent.id}>{ent.type} · {ent.title}</option>
              ))}
            </select>
            <button onClick={() => setShowNew(!showNew)} className="btn" style={{ flexShrink: 0 }}>
              ＋ 新建
            </button>
          </div>
          {showNew && (
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <select value={newType} onChange={(e) => setNewType(e.target.value)} className="select">
                {entityTypes.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createNew()}
                placeholder="实体名（如：海边的卡夫卡）"
                className="input"
                style={{ flex: 1 }}
              />
              <button onClick={createNew} className="btn btn-primary" style={{ flexShrink: 0 }}>
                创建并挂载
              </button>
            </div>
          )}
        </div>

        {error && <p style={{ color: 'var(--seal)', fontSize: 13, margin: '10px 0 0' }}>{error}</p>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
          <button onClick={onClose} disabled={busy} className="btn">
            取消
          </button>
          <button onClick={save} disabled={busy} className="btn btn-primary" style={{ opacity: busy ? 0.6 : 1 }}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

// 演化链节点卡（前驱灰卡 / 本笔记 / 后继）
function ChainCard({
  id,
  title,
  time,
  kind,
  status,
  onClick,
}: {
  id: number;
  title: string;
  time: string | null;
  kind: string;
  status: string;
  onClick: () => void;
}) {
  const dead = status === 'superseded';
  return (
    <div
      onClick={onClick}
      className="card card-hover"
      style={{
        minWidth: 180,
        maxWidth: 240,
        padding: '11px 15px',
        background: dead ? 'var(--paper-2)' : 'var(--card-tint)',
        border: '1px solid ' + (dead ? 'var(--line)' : 'var(--line-strong)'),
        cursor: 'pointer',
        textAlign: 'center',
      }}
    >
      <div
        style={{
          fontSize: 14,
          fontWeight: 700,
          fontFamily: 'var(--font-serif)',
          color: dead ? 'var(--ink-3)' : 'var(--ink)',
          textDecoration: dead ? 'line-through' : 'none',
          letterSpacing: '0.02em',
        }}
      >
        {title}
      </div>
      <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>
        {dead ? '【已失效】' : KIND_LABEL[kind] ?? kind}
        {time ? ` · ${time.slice(0, 10)}` : ''}
      </div>
    </div>
  );
}

export default function NoteDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [tree, setTree] = useState<Array<{ path: string; parent: string | null }>>([]);

  useEffect(() => {
    fetch(`/api/notes/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setDetail)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    // 分类树（编辑弹窗的分类下拉）
    fetch('/api/categories')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setTree(d.tree ?? []))
      .catch(() => {});
  }, [id]);

  if (error) return <main style={{ padding: 40, textAlign: 'center', color: 'var(--seal)' }}>⚠️ 笔记不存在或加载失败：{error}</main>;
  if (!detail) return <main style={{ padding: 40, textAlign: 'center', color: 'var(--ink-3)' }}>加载中…</main>;

  const { note, entity, evolution, predecessors, successor, related } = detail;
  const evoStyle = evoStyleOf(note.status === 'superseded' ? 'EVOLVE' : note.kind === 'essay' ? 'EXPAND' : 'NEW');

  return (
    <main className="page page-narrow">
      {/* 面包屑 */}
      <div style={{ fontSize: 13, color: 'var(--ink-3)', marginBottom: 16 }}>
        <a href="/" style={{ color: 'var(--seal)', textDecoration: 'none' }}>图书馆</a>
        <span style={{ margin: '0 6px', color: 'var(--ink-4)' }}>/</span>
        <span>{note.category}</span>
      </div>

      {/* ── 笔记主卡 ── */}
      <section className="card rise" style={{ padding: '22px 26px' }}>
        {note.status === 'superseded' && successor && (
          <div
            style={{
              background: 'var(--paper)',
              border: '1px solid var(--line)',
              borderRadius: 4,
              padding: '8px 12px',
              fontSize: 13,
              color: 'var(--ink-3)',
              marginBottom: 14,
            }}
          >
            这条笔记已失效，被 <a href={`/notes/${successor.id}`} style={{ color: 'var(--seal)', fontWeight: 600, textDecoration: 'none' }}>《{successor.title}》</a> 取代 —— 历史经历永不删除，保留在此供回溯。
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: 22, margin: 0, color: 'var(--ink)', fontFamily: 'var(--font-serif)', letterSpacing: '0.04em' }}>{note.title}</h1>
          <Badge bg={evoStyle.bg} color={evoStyle.color}>{KIND_LABEL[note.kind] ?? note.kind}</Badge>
          <Badge bg="var(--paper)" color="var(--ink-2)">{note.category}</Badge>
          {note.status === 'superseded' && <Badge bg="var(--paper-2)" color="var(--ink-3)">已失效</Badge>}
          <button
            onClick={() => setEditing(true)}
            className="btn"
            style={{ marginLeft: 'auto', flexShrink: 0, borderColor: 'var(--seal)', color: 'var(--seal)' }}
          >
            ✏️ 编辑
          </button>
        </div>

        {entity && (
          <div style={{ marginTop: 10, fontSize: 13, color: 'var(--ink-2)' }}>
            {ENTITY_TYPE_LABEL[entity.type] ?? entity.type} {entity.title}
            {entity.creator ? ` · ${entity.creator}` : ''}
            {entity.year ? ` · ${entity.year}` : ''}
          </div>
        )}

        <p style={{ fontSize: 15, lineHeight: 2, color: 'var(--ink-2)', margin: '16px 0 0', whiteSpace: 'pre-wrap' }}>{note.content}</p>

        {/* 元信息 */}
        <div
          style={{
            marginTop: 18,
            paddingTop: 14,
            borderTop: '1px solid var(--line)',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '6px 18px',
            fontSize: 12,
            color: 'var(--ink-3)',
            letterSpacing: '0.03em',
          }}
        >
          <span>有效时间：{note.valid_at?.slice(0, 10) ?? '未知（待修正）'}</span>
          <span>置信度：{note.confidence.toFixed(2)}</span>
          <span>来源：{note.source}{note.source_ref ? `（${note.source_ref}）` : ''}</span>
          <span>被读取 {note.access_count} 次</span>
        </div>
      </section>

      {/* ── 演化链 EvolutionChain ── */}
      <section style={{ marginTop: 26 }}>
        <h2 style={{ fontSize: 16, margin: '0 0 12px', color: 'var(--ink)', fontFamily: 'var(--font-serif)', letterSpacing: '0.05em' }}>演化链 · 陪我长大</h2>

        {(predecessors.length > 0 || successor || evolution.length > 0) ? (
          <div style={{ display: 'flex', alignItems: 'stretch', gap: 10, flexWrap: 'wrap' }}>
            {/* 前驱（被本笔记取代的旧笔记） */}
            {predecessors.map((p) => (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <ChainCard id={p.id} title={p.title} time={p.valid_at} kind={p.kind} status="superseded" onClick={() => (window.location.href = `/notes/${p.id}`)} />
                <span style={{ color: '#cbd5e1', fontSize: 18 }}>→</span>
              </div>
            ))}
            {/* 本笔记 */}
            <ChainCard id={note.id} title={note.title} time={note.valid_at} kind={note.kind} status={note.status} onClick={() => (window.location.href = `/notes/${note.id}`)} />
            {/* 后继 */}
            {successor && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ color: '#cbd5e1', fontSize: 18 }}>→</span>
                <ChainCard id={successor.id} title={successor.title} time={null} kind="" status="active" onClick={() => (window.location.href = `/notes/${successor.id}`)} />
              </div>
            )}
          </div>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: 0 }}>还没有演化事件——这是一条独立的新记忆。</p>
        )}

        {/* 事件时间线 */}
        {evolution.length > 0 && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {evolution.map((e) => {
              const s = evoStyleOf(e.type);
              return (
                <div key={e.id} className="card" style={{ padding: '10px 14px', fontSize: 13 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Badge bg={s.bg} color={s.color}>{s.label}</Badge>
                    <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>
                      {e.created_at.slice(0, 16).replace('T', ' ')}
                      {e.prevTitle ? ` · 前驱《${e.prevTitle}》` : ''}
                      {e.nextTitle ? ` · 后继《${e.nextTitle}》` : ''}
                    </span>
                  </div>
                  <div style={{ color: 'var(--ink-2)', marginTop: 4, lineHeight: 1.7 }}>{e.reason}</div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── 相关笔记 ── */}
      {related.length > 0 && (
        <section style={{ marginTop: 26 }}>
          <h2 style={{ fontSize: 16, margin: '0 0 12px', color: 'var(--ink)', fontFamily: 'var(--font-serif)', letterSpacing: '0.05em' }}>
            相关笔记（{related.length}）
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {related.map((r) => (
              <a
                key={r.id}
                href={`/notes/${r.id}`}
                className="card card-hover"
                style={{
                  padding: '10px 14px',
                  fontSize: 14,
                  color: r.status === 'superseded' ? 'var(--ink-3)' : 'var(--ink)',
                  textDecoration: r.status === 'superseded' ? 'line-through' : 'none',
                  display: 'flex',
                  justifyContent: 'space-between',
                }}
              >
                <span style={{ fontFamily: 'var(--font-serif)', fontWeight: 600 }}>{r.title}</span>
                <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{KIND_LABEL[r.kind] ?? r.kind}{r.status === 'superseded' ? ' · 已失效' : ''}</span>
              </a>
            ))}
          </div>
        </section>
      )}

      {editing && (
        <EditModal
          note={note}
          tree={tree}
          onClose={() => setEditing(false)}
          onSaved={(d) => {
            setDetail(d);
            setEditing(false);
          }}
        />
      )}
    </main>
  );
}
