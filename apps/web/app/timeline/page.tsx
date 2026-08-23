// 时间线：按有效时间（valid_at）年月分组；无时间归"时间未知"
// 2026-08-23 前端重构：档案墨线轴 + 藏书票红节点
import { KIND_LABEL, categoryColor, type Note } from '../../components/shared';

const API = 'http://localhost:8899';

async function fetchNotes(): Promise<Note[]> {
  try {
    const res = await fetch(`${API}/api/notes?limit=200`, { cache: 'no-store' });
    if (!res.ok) return [];
    return (await res.json()).rows ?? [];
  } catch {
    return [];
  }
}

// 时间取值：有效时间（事实时间，如 '2018-06-06'）；无则归"时间未知"
function timeOf(n: Note): string {
  return n.valid_at?.slice(0, 10) ?? '';
}

export default async function Timeline() {
  const rows = await fetchNotes();

  // 按 YYYY-MM 分组（保持后端 desc 顺序，组内即时间序）；无时间归"未知"组
  const groups = new Map<string, Note[]>();
  for (const n of rows) {
    const t = timeOf(n);
    const key = t ? t.slice(0, 7) : '未知';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(n);
  }
  const sorted = [...groups.entries()].sort((a, b) => (b[0] === '未知' ? -1 : a[0] === '未知' ? 1 : b[0].localeCompare(a[0])));

  return (
    <main className="page">
      <header className="page-head rise">
        <div className="page-title">
          <span className="seal">KBF</span>
          <span>时间线</span>
        </div>
        <p className="page-sub">按事实时间排列 · {rows.length} 卷（非归档）</p>
      </header>

      {sorted.length === 0 ? (
        <p style={{ color: '#9a9181' }}>暂无数据。</p>
      ) : (
        <div className="axis">
          <div className="axis-line" />

          {sorted.map(([month, notes]) => (
            <div key={month} style={{ marginBottom: 30, position: 'relative' }}>
              <div className="axis-node" />
              <h2 className="axis-month">
                {month === '未知' ? '时间未知（待修正）' : `${month.slice(0, 4)} 年 ${Number(month.slice(5, 7))} 月`}
                <span className="serial">{notes.length} 卷</span>
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {notes.map((n, i) => (
                  <a
                    key={n.id}
                    href={`/notes/${n.id}`}
                    className="card card-hover rise"
                    style={{ padding: '12px 16px', textDecoration: 'none', color: 'inherit', display: 'block', animationDelay: `${Math.min(i, 10) * 30}ms` }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                      <span className="serial" style={{ color: '#a8863c' }}>{timeOf(n)}</span>
                      <span className="tag" style={{ background: categoryColor(n.category) }}>
                        {n.category.split('/').pop()}
                      </span>
                      <span style={{ color: '#655d4f', fontSize: 12 }}>{KIND_LABEL[n.kind] ?? n.kind}</span>
                      {n.status === 'superseded' && <span className="tag ghost">已失效</span>}
                    </div>
                    <h3
                      style={{
                        margin: 0,
                        fontSize: 15,
                        fontFamily: 'var(--font-serif)',
                        fontWeight: 700,
                        letterSpacing: '0.03em',
                        textDecoration: n.status === 'superseded' ? 'line-through' : 'none',
                      }}
                    >
                      {n.title}
                    </h3>
                    <p style={{ margin: '5px 0 0', color: '#655d4f', fontSize: 13, lineHeight: 1.7 }}>{n.content.slice(0, 120)}</p>
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
