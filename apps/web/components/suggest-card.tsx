// 对话建议卡片：LLM 判定用户长消息值得写入图书馆时，显示在用户消息下方
// 点击"查看并确认" → 打开 WriteNoteModal（预填建议值）；✕ 忽略（本会话内不再建议同话题）
// 2026-08-23 前端重构：档案风（纸卡 + 印章红边条）
'use client';
import { KIND_LABEL, categoryColor } from './shared';

export interface SuggestData {
  title: string;
  category: string | null;
  content: string;
  kind?: string | null;
  validAt?: string | null;
  reason?: string | null;
}

export function SuggestCard({ suggest, onOpen, onDismiss }: { suggest: SuggestData; onOpen: () => void; onDismiss: () => void }) {
  return (
    <div
      className="card rise"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        margin: '8px 0 2px',
        maxWidth: '85%',
        width: 'fit-content',
        background: 'var(--card-tint)',
        borderLeft: '3px solid var(--seal)',
        padding: '9px 13px',
      }}
    >
      <span style={{ fontSize: 15, flexShrink: 0 }}>💡</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--seal)', fontSize: 12, fontWeight: 600, letterSpacing: '0.05em' }}>建议记入图书馆</span>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)', fontFamily: 'var(--font-serif)' }}>{suggest.title}</span>
          {suggest.category && (
            <span className="tag" style={{ background: categoryColor(suggest.category) }}>
              {suggest.category.split('/').pop()}
            </span>
          )}
          {suggest.kind && <span style={{ color: '#9a9181', fontSize: 11.5 }}>{KIND_LABEL[suggest.kind] ?? suggest.kind}</span>}
        </div>
        <div style={{ marginTop: 3, fontSize: 12.5, color: '#655d4f', display: 'flex', alignItems: 'center', gap: 10 }}>
          {suggest.reason && <span>{suggest.reason}</span>}
          <button
            onClick={onOpen}
            className="btn"
            style={{ padding: '2px 10px', fontSize: 12, border: '1px solid var(--seal)', color: 'var(--seal)', background: 'transparent' }}
          >
            ✏️ 查看并确认
          </button>
        </div>
      </div>
      <button
        onClick={onDismiss}
        title="忽略（本会话不再建议）"
        style={{ border: 'none', background: 'none', color: '#c2b9a6', cursor: 'pointer', fontSize: 14, padding: '2px 4px' }}
      >
        ✕
      </button>
    </div>
  );
}
