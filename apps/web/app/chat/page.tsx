// 对话页：SSE 流式 + 注入 chip + 记忆建议卡片 + 会话侧边栏
// 2026-08-23 前端重构：档案风（墨色会话目录 + 纸色气泡），逻辑不变
'use client';

import { useState, useRef, useEffect } from 'react';
import { SuggestCard, type SuggestData } from '../../components/suggest-card';
import { WriteNoteModal } from '../../components/write-note-modal';
import type { TreeItem } from '../../components/shared';

interface ChipNote {
  id: number;
  title: string;
  content: string;
  status: string;
  time: string | null;
  identity: 'read' | 'wrote' | 'lived' | 'past';
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  chips?: ChipNote[];
  suggestion?: SuggestData | null; // 2026-08-23：挂在本轮用户消息上（LLM 建议写入图书馆）
}

const IDENTITY_ICON = { read: '📚', wrote: '✍️', lived: '🧠', past: '⏳' } as const;
const IDENTITY_LABEL = { read: '读过', wrote: '写过', lived: '经历过', past: '过往' } as const;

interface Conv {
  uid: string;
  title: string;
  updated_at: string;
  msg_count: number;
  first_message: string | null;
}

function Chip({ note }: { note: ChipNote }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      onClick={() => setOpen(!open)}
      title={note.title}
      className="tag"
      style={{
        background: note.status === 'superseded' ? 'var(--paper-2)' : 'var(--seal-soft)',
        color: note.status === 'superseded' ? 'var(--ink-3)' : 'var(--seal-dark)',
        cursor: 'pointer',
        border: '1px solid ' + (note.status === 'superseded' ? 'var(--line)' : 'rgba(179,70,46,0.35)'),
        textDecoration: note.status === 'superseded' ? 'line-through' : 'none',
        position: 'relative',
      }}
    >
      {IDENTITY_ICON[note.identity]} {note.title.slice(0, 10)}
      {open && (
        <span
          style={{
            display: 'block',
            position: 'absolute',
            marginTop: 22,
            marginLeft: -8,
            background: 'var(--card)',
            border: '1px solid var(--line-strong)',
            borderRadius: 6,
            padding: 9,
            boxShadow: 'var(--shadow-lift)',
            zIndex: 10,
            maxWidth: 320,
            fontSize: 12,
            color: 'var(--ink-2)',
            fontWeight: 400,
            letterSpacing: '0.02em',
          }}
        >
          <div style={{ marginBottom: 4 }}>
            {IDENTITY_LABEL[note.identity]} · {note.time ?? '时间未知'}
            {note.status === 'superseded' ? ' · 已失效' : ''}
          </div>
          {note.content.slice(0, 200)}
        </span>
      )}
    </span>
  );
}

// 侧边栏会话项：有自定义标题显示标题，否则首条消息摘要；hover 显示 ✏️ 重命名
function SessionItem({
  conv,
  active,
  editing,
  value,
  onSelect,
  onStartEdit,
  onSave,
  onCancel,
  onChange,
}: {
  conv: Conv;
  active: boolean;
  editing: boolean;
  value: string;
  onSelect: () => void;
  onStartEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  onChange: (v: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const hasTitle = !!conv.title && conv.title !== '新对话';
  const display = hasTitle ? conv.title : conv.first_message ?? '（空会话）';

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onSelect}
      style={{
        width: '100%',
        padding: '10px 12px',
        borderRadius: 6,
        background: active ? 'var(--ink)' : 'transparent',
        color: active ? 'var(--paper)' : 'var(--ink-2)',
        cursor: 'pointer',
        marginBottom: 2,
        boxSizing: 'border-box',
        transition: 'background 0.12s ease',
      }}
    >
      {editing ? (
        <input
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSave();
            else if (e.key === 'Escape') onCancel();
          }}
          onBlur={onSave}
          placeholder="输入标题（空 = 恢复摘要）"
          className="input"
          style={{ width: '100%', boxSizing: 'border-box', padding: '2px 7px', fontSize: 13 }}
        />
      ) : (
        <>
          <div
            style={{
              fontSize: 13,
              fontWeight: hasTitle ? 700 : 600,
              fontFamily: hasTitle ? 'var(--font-serif)' : 'var(--font-sans)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              letterSpacing: '0.02em',
            }}
          >
            {display.slice(0, 22)}
          </div>
          <div style={{ fontSize: 11, opacity: 0.65, marginTop: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>{conv.msg_count} 条 · {conv.updated_at.slice(5, 16)}</span>
            {hovered && (
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  onStartEdit();
                }}
                style={{ marginLeft: 'auto', cursor: 'pointer', fontSize: 11 }}
                title="修改标题"
              >
                ✏️
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [convId, setConvId] = useState<string | null>(null);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [editingUid, setEditingUid] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [journalMode, setJournalMode] = useState<'locked' | 'unlocked'>('locked');
  const [toggling, setToggling] = useState(false);
  // 记忆建议：dismissed = 本会话已忽略/已写入的建议 title（不再打扰）；suggestModal = 确认弹窗内容
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [suggestModal, setSuggestModal] = useState<SuggestData | null>(null);
  const [tree, setTree] = useState<TreeItem[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const STORAGE_KEY = 'kbf-conv-id';

  // 分类树（确认弹窗的分类下拉用）
  useEffect(() => {
    fetch('/api/categories')
      .then((r) => r.json())
      .then((d: { tree?: TreeItem[] }) => d.tree && setTree(d.tree))
      .catch(() => {});
  }, []);

  // 历史模式开关：解锁后 journal 日志可被检索（默认 archived 不打扰）
  useEffect(() => {
    fetch('/api/journal-mode')
      .then((r) => r.json())
      .then((d: { mode?: 'locked' | 'unlocked' }) => d.mode && setJournalMode(d.mode))
      .catch(() => {});
  }, []);

  function toggleJournalMode() {
    if (toggling) return;
    setToggling(true);
    const next = journalMode === 'locked' ? 'unlocked' : 'locked';
    fetch('/api/journal-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: next }),
    })
      .then((r) => r.json())
      .then((d: { ok?: boolean; mode?: 'locked' | 'unlocked' }) => {
        if (d.ok && d.mode) setJournalMode(d.mode);
      })
      .catch(() => {})
      .finally(() => setToggling(false));
  }

  // debug 工具：会话下拉列表
  function loadConvs() {
    fetch('/api/conversations')
      .then((r) => r.json())
      .then((d: { conversations?: typeof convs }) => d.conversations && setConvs(d.conversations))
      .catch(() => {});
  }
  function switchConv(uid: string) {
    if (!uid) {
      setConvId(null);
      setMessages([]);
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    setConvId(uid);
    localStorage.setItem(STORAGE_KEY, uid);
    fetch(`/api/conversations/${uid}/messages`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { messages?: Array<{ role: string; content: string }> }) => {
        setMessages((d.messages ?? []).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })));
      })
      .catch(() => {});
  }

  // 会话重命名：PATCH 保存（空 = 恢复默认），失败刷新回原样
  function saveRename(uid: string) {
    const title = editTitle.trim();
    setEditingUid(null);
    fetch(`/api/conversations/${uid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(() => loadConvs())
      .catch(() => loadConvs());
  }

  // 加载：拉会话列表 + 恢复 localStorage 里的会话
  useEffect(() => {
    loadConvs();
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) switchConv(saved);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    setLoading(true);
    setMessages((m) => [...m, { role: 'user', content: text }]);

    // 占位 assistant 消息（流式填充）
    const assistantIdx = messages.length + 1;
    setMessages((m) => [...m, { role: 'assistant', content: '', chips: [] }]);

    // 流式增量更新占位消息（try/catch 共用，需定义在 try 外）
    const apply = (fn: (m: Message) => Message) =>
      setMessages((msgs) => msgs.map((m, i) => (i === assistantIdx ? fn(m) : m)));

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, conversationId: convId ?? undefined }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventName = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const lines = part.split('\n');
          for (const line of lines) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) {
              const data = JSON.parse(line.slice(5).trim());
              if (eventName === 'memory-injected') {
                apply((m) => ({ ...m, chips: data.notes as ChipNote[] }));
              } else if (eventName === 'delta') {
                apply((m) => ({ ...m, content: m.content + data.text }));
              } else if (eventName === 'memory-suggest') {
                // 建议卡片挂到本轮用户消息（assistantIdx - 1）；忽略过的话题不再出现
                const s = data as SuggestData;
                if (!dismissed.has(s.title)) {
                  setMessages((msgs) => msgs.map((m, i) => (i === assistantIdx - 1 ? { ...m, suggestion: s } : m)));
                }
              } else if (eventName === 'done') {
                setConvId(data.conversationId);
                localStorage.setItem(STORAGE_KEY, data.conversationId);
                loadConvs(); // 刷新会话列表（消息数/时间变化）
              } else if (eventName === 'error') {
                apply((m) => ({ ...m, content: `⚠️ ${data.message}` }));
              }
            }
          }
        }
      }
    } catch (err) {
      apply((m) => ({ ...m, content: `⚠️ 出错了：${err instanceof Error ? err.message : err}` }));
    }
    setLoading(false);
  }

  return (
    <main className="page" style={{ maxWidth: 1080, padding: '18px 20px 0', display: 'flex', gap: 18, height: 'calc(100vh - 52px)' }}>
      {/* 左侧会话目录 */}
      <aside className="side-panel" style={{ width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px', borderBottom: '1px solid var(--line)' }}>
          <h2 style={{ margin: '0 0 10px', fontSize: 15, fontFamily: 'var(--font-serif)', letterSpacing: '0.05em' }}>💬 会话目录</h2>
          <button onClick={() => switchConv('')} className="btn" style={{ width: '100%' }} title="清空当前会话，开始新对话">
            ＋ 新对话
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
          {convs.length === 0 && <p style={{ color: '#9a9181', fontSize: 12, textAlign: 'center', marginTop: 24 }}>暂无历史会话</p>}
          {convs.map((c) => (
            <SessionItem
              key={c.uid}
              conv={c}
              active={convId === c.uid}
              editing={editingUid === c.uid}
              value={editTitle}
              onSelect={() => switchConv(c.uid)}
              onStartEdit={() => {
                setEditingUid(c.uid);
                setEditTitle(c.title && c.title !== '新对话' ? c.title : '');
              }}
              onSave={() => saveRename(c.uid)}
              onCancel={() => setEditingUid(null)}
              onChange={setEditTitle}
            />
          ))}
        </div>
      </aside>

      {/* 右侧对话区 */}
      <section style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 12, borderBottom: '1px solid var(--line)' }}>
          <h1 style={{ fontSize: 18, margin: 0, fontFamily: 'var(--font-serif)', letterSpacing: '0.05em' }}>对话</h1>
          <button
            onClick={toggleJournalMode}
            disabled={toggling}
            title={journalMode === 'locked' ? '日志已归档（默认不注入）。点击解锁历史模式' : '历史模式已开（日志可被检索）。点击恢复归档'}
            className="btn"
            style={{
              marginLeft: 'auto',
              background: journalMode === 'unlocked' ? 'var(--rust)' : 'var(--card)',
              borderColor: journalMode === 'unlocked' ? 'var(--rust)' : 'var(--line-strong)',
              color: journalMode === 'unlocked' ? '#fdfbf4' : 'var(--ink-2)',
              flexShrink: 0,
            }}
          >
            ⏳ {journalMode === 'locked' ? '日志已归档' : '历史模式'}
          </button>
        </header>

        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 4px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {messages.length === 0 && (
            <p style={{ color: '#9a9181', textAlign: 'center', marginTop: 80, fontFamily: 'var(--font-serif)', letterSpacing: '0.06em' }}>
              和老朋友聊聊吧——他记得你。
              <span className="caret" style={{ marginLeft: 2, color: 'var(--seal)' }}>▍</span>
            </p>
          )}
          {messages.map((m, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
              {m.chips && m.chips.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6, position: 'relative' }}>
                  {m.chips.map((c) => (
                    <Chip key={c.id} note={c} />
                  ))}
                </div>
              )}
              <div className={`chat-bubble ${m.role === 'user' ? 'user' : 'assistant'}`}>
                {m.content || (loading && i === messages.length - 1 ? '…' : '')}
              </div>
              {/* 记忆建议卡片：挂在用户消息下方（忽略后本会话不再出现） */}
              {m.role === 'user' && m.suggestion && (
                <SuggestCard
                  suggest={m.suggestion}
                  onOpen={() => setSuggestModal(m.suggestion!)}
                  onDismiss={() => {
                    setDismissed((prev) => new Set(prev).add(m.suggestion!.title));
                    setMessages((msgs) => msgs.map((x, j) => (j === i ? { ...x, suggestion: null } : x)));
                  }}
                />
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <div style={{ padding: '12px 0 24px', display: 'flex', gap: 8 }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            placeholder="说点什么…"
            className="chat-input"
          />
          <button onClick={send} disabled={loading} className="btn btn-primary" style={{ padding: '0 24px' }}>
            发送
          </button>
        </div>
      </section>

      {/* 建议确认弹窗：预填 LLM 建议值，source='chat'（source_ref 落 'chat'） */}
      {suggestModal && (
        <WriteNoteModal
          tree={tree}
          initial={{
            text: suggestModal.content,
            title: suggestModal.title,
            category: suggestModal.category ?? undefined,
            kind: suggestModal.kind ?? undefined,
            validAt: suggestModal.validAt ?? undefined,
          }}
          source="chat"
          onClose={() => setSuggestModal(null)}
          onSaved={() => {
            // 写入成功：该话题本会话不再建议 + 收起卡片
            setDismissed((prev) => new Set(prev).add(suggestModal.title));
            setMessages((msgs) => msgs.map((m) => (m.suggestion?.title === suggestModal.title ? { ...m, suggestion: null } : m)));
            setSuggestModal(null);
          }}
        />
      )}
    </main>
  );
}
