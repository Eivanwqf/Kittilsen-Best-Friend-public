// 设置：journal 归档模式 + LLM API 配置 + 数据统计 + 备份导出
// 2026-08-23 前端重构：档案风表单卡
'use client';
import { useEffect, useState } from 'react';

interface Stats {
  tables: number;
  notes: number;
  categories: number;
}

export default function Settings() {
  const [mode, setMode] = useState<'locked' | 'unlocked' | null>(null);
  const [journalCount, setJournalCount] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [busy, setBusy] = useState(false);
  const [apiConfigured, setApiConfigured] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [apiModel, setApiModel] = useState('');
  const [apiFormat, setApiFormat] = useState('openai');
  const [apiSaving, setApiSaving] = useState(false);
  const [apiSaved, setApiSaved] = useState(false);
  const [apiError, setApiError] = useState('');

  useEffect(() => {
    (async () => {
      const [modeRes, healthRes, notesRes, catRes] = await Promise.all([
        fetch('/api/journal-mode'),
        fetch('/api/health'),
        fetch('/api/notes?limit=1'),
        fetch('/api/categories'),
      ]);
      if (modeRes.ok) setMode((await modeRes.json()).mode);
      const health = healthRes.ok ? await healthRes.json() : null;
      const notes = notesRes.ok ? await notesRes.json() : null;
      const cats = catRes.ok ? await catRes.json() : null;
      setStats({
        tables: health?.db?.tables ?? 0,
        notes: notes?.total ?? 0,
        categories: cats?.tree?.length ?? 0,
      });
      // LLM 配置状态（key 不回显；baseUrl/model 显示当前值）
      const apiRes = await fetch('/api/settings/llm');
      if (apiRes.ok) {
        const d = await apiRes.json();
        setApiConfigured(d.configured);
        setApiBaseUrl(d.baseUrl);
        setApiModel(d.model);
        setApiFormat(d.format);
      }
    })();
  }, []);

  // 保存 LLM 配置（key/baseUrl/model 写入 .env + 运行时，立即生效无需重启）
  const saveApiKey = async () => {
    if (apiSaving) return;
    setApiSaving(true);
    setApiError('');
    setApiSaved(false);
    try {
      const body: Record<string, string> = { baseUrl: apiBaseUrl.trim(), model: apiModel.trim(), format: apiFormat };
      if (apiKey.trim()) body.key = apiKey.trim(); // key 留空 = 不修改
      const res = await fetch('/api/settings/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok) {
        setApiError(d.error ?? '保存失败');
        return;
      }
      setApiConfigured(d.configured);
      setApiKey('');
      setApiSaved(true);
    } catch {
      setApiError('请求失败，请确认 server 已启动');
    } finally {
      setApiSaving(false);
    }
  };

  const toggleJournal = async () => {
    if (!mode || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/journal-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: mode === 'locked' ? 'unlocked' : 'locked' }),
      });
      if (res.ok) {
        const data = await res.json();
        setMode(data.mode);
        setJournalCount(data.journalCount ?? 0);
      }
    } finally {
      setBusy(false);
    }
  };

  const card: React.CSSProperties = {
    border: '1px solid var(--line)',
    borderRadius: 6,
    padding: '18px 22px',
    background: 'var(--card)',
    boxShadow: 'var(--shadow-card)',
  };
  const sectionTitle: React.CSSProperties = { margin: 0, fontSize: 16, fontFamily: 'var(--font-serif)', letterSpacing: '0.04em' };
  const sectionDesc: React.CSSProperties = { color: 'var(--ink-3)', fontSize: 12.5, margin: '6px 0 14px', lineHeight: 1.7 };

  return (
    <main className="page page-narrow">
      <header className="page-head rise">
        <div className="page-title">
          <span className="seal">KBF</span>
          <span>设置</span>
        </div>
        <p className="page-sub">运行参数与数据管理</p>
      </header>

      {/* journal 归档模式 */}
      <section style={card} className="rise">
        <h2 style={sectionTitle}>⏳ 日志归档模式</h2>
        <p style={sectionDesc}>
          locked：40 篇日志归档（检索/列表全排除）；unlocked：恢复为可检索的过去记忆（⏳+降权）。
          {journalCount > 0 && ` 当前影响 ${journalCount} 篇日志。`}
        </p>
        <button
          onClick={toggleJournal}
          disabled={busy || mode === null}
          className="btn"
          style={{
            background: mode === 'unlocked' ? 'var(--rust)' : 'var(--ink)',
            borderColor: mode === 'unlocked' ? 'var(--rust)' : 'var(--ink)',
            color: '#fdfbf4',
            opacity: mode === null ? 0.5 : 1,
          }}
        >
          {mode === null ? '加载中…' : busy ? '切换中…' : mode === 'locked' ? '当前 locked — 点击解锁' : '当前 unlocked — 点击锁定'}
        </button>
      </section>

      {/* LLM API 配置（兼容 OpenAI 格式端点，不限于 DeepSeek） */}
      <section style={{ ...card, marginTop: 18 }} className="rise">
        <h2 style={sectionTitle}>🔑 LLM API 配置</h2>
        <p style={sectionDesc}>
          状态：{apiConfigured ? '✅ 已配置' : '⚠️ 未配置'}（保存后立即生效，无需重启；Key 只写入 .env，不在页面回显；Key 留空 = 不修改）
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="API Key（sk- 开头）"
            className="input"
          />
          <input
            value={apiBaseUrl}
            onChange={(e) => setApiBaseUrl(e.target.value)}
            placeholder="Base URL（如 https://api.deepseek.com）"
            className="input"
          />
          <input
            value={apiModel}
            onChange={(e) => setApiModel(e.target.value)}
            placeholder="模型名（如 deepseek-chat）"
            className="input"
          />
          <select value={apiFormat} onChange={(e) => setApiFormat(e.target.value)} className="select">
            <option value="openai">OpenAI 兼容（/chat/completions）</option>
            <option value="anthropic">Anthropic（/v1/messages，Qwen/MiniMax 等）</option>
            <option value="responses">OpenAI Responses（/v1/responses，Grok/GPT Luna）</option>
          </select>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button onClick={saveApiKey} disabled={apiSaving} className="btn btn-primary">
              {apiSaving ? '保存中…' : '保存配置'}
            </button>
          </div>
        </div>
        {apiSaved && <p style={{ color: 'var(--rust)', fontSize: 13, margin: '10px 0 0' }}>✅ 配置已更新并生效</p>}
        {apiError && <p style={{ color: 'var(--seal)', fontSize: 13, margin: '10px 0 0' }}>{apiError}</p>}
      </section>

      {/* 数据统计 */}
      <section style={{ ...card, marginTop: 18 }} className="rise">
        <h2 style={sectionTitle}>📊 数据统计</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginTop: 12 }}>
          {[
            { label: '笔记数', value: stats ? stats.notes : '—' },
            { label: '分类数', value: stats ? stats.categories : '—' },
            { label: '数据表', value: stats ? stats.tables : '—' },
          ].map((s) => (
            <div
              key={s.label}
              style={{ background: 'var(--paper)', borderRadius: 6, padding: 14, textAlign: 'center', border: '1px solid var(--line)' }}
            >
              <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--seal)', fontFamily: 'var(--font-serif)' }}>{s.value}</div>
              <div style={{ color: 'var(--ink-3)', fontSize: 12, marginTop: 3, letterSpacing: '0.06em' }}>{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* 备份导出 */}
      <section style={{ ...card, marginTop: 18 }} className="rise">
        <h2 style={sectionTitle}>💾 备份导出</h2>
        <p style={sectionDesc}>
          生成 WAL 一致性 SQLite 快照（含全部笔记、向量、FTS 索引）。快照同时保留在 server 的 data/backups/ 目录。
        </p>
        <a href="/api/export" download className="btn btn-primary" style={{ display: 'inline-block', textDecoration: 'none' }}>
          下载完整备份（.db）
        </a>
      </section>
    </main>
  );
}
