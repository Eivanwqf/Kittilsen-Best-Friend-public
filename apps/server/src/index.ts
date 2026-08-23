import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { nanoid } from 'nanoid';
import {
  openDatabase,
  listNotes,
  getNoteDetail,
  getNote,
  createImportJob,
  analyzeImport,
  commitImport,
  getImportJob,
  scanMemoryFiles,
  retrieveMemory,
  buildSystemPrompt,
  chatStream,
  identityOf,
  suggestMemory,
  SUGGEST_MIN_CHARS,
  type SuggestDecision,
  getJournalMode,
  setJournalMode,
  createNoteFromText,
  listCategories,
  embedder,
  upsertVector,
  listEntities,
  createEntity,
  getEntity,
  CATEGORY_TREE,
} from '@kbf/core';

// 原子记忆长度上限（与 markdown-parser 的 MAX_NOTE_LENGTH 同源：300 字）
const MAX_NOTE_LENGTH = 300;

// workspace 包运行时 cwd 不在项目根：.env 和 DB_PATH 一律锚定项目根
const ROOT = path.resolve(import.meta.dirname, '../../..');
dotenv.config({ path: path.join(ROOT, '.env') });
const dbPath = (() => {
  const raw = process.env.DB_PATH ?? './data/kittilsen.db';
  return path.isAbsolute(raw) ? raw : path.resolve(ROOT, raw);
})();

// 数据库首次真正落盘（data/kittilsen.db）
const db = openDatabase(dbPath);

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

app.get('/api/health', async () => {
  const tables = (db.prepare("select count(*) c from sqlite_master where type='table'").get() as { c: number }).c;
  return {
    ok: true,
    service: 'kittilsen-best-friend',
    version: '0.1.0',
    db: { path: process.env.DB_PATH ?? './data/kittilsen.db', tables },
  };
});

// notes 路由（M1 起点）
app.get('/api/notes', async (req) => {
  const { category, status, kind, search, limit = '50', offset = '0' } = req.query as Record<string, string | undefined>;
  const { rows, total } = listNotes(db, {
    category,
    status,
    kind,
    search,
    limit: Number(limit),
    offset: Number(offset),
  });
  return { total, rows };
});

// 详情（M3 演化闭环）：本体 + 实体 + 演化事件 + 前驱/后继 + 相关链接
app.get('/api/notes/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const detail = getNoteDetail(db, Number(id));
  if (!detail) return reply.code(404).send({ error: 'note not found' });
  return detail;
});

// 记忆编辑（2026-08-05 用户核心需求）：逐条修正 title/content/category/kind/valid_at/entity_id
// content/title 变更 → 重算向量（category/kind/valid_at 不进向量，不重算）；FTS 由触发器同步
app.patch('/api/notes/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const noteId = Number(id);
  const note = getNote(db, noteId);
  if (!note) return reply.code(404).send({ error: 'note not found' });

  const body = req.body as {
    title?: string;
    content?: string;
    category?: string;
    kind?: string;
    valid_at?: string | null;
    entity_id?: number | null; // 挂载/解除实体（2026-08-08 实体手动化）
  };
  const validKinds = ['experience', 'preference', 'reading_note', 'essay', 'decision', 'principle'];
  const validCategories = listCategories(db);
  const sets: string[] = [];
  const params: Record<string, unknown> = {};

  const title = body.title?.trim();
  if (title !== undefined) {
    if (!title) return reply.code(400).send({ error: '标题不能为空' });
    if (title.length > 100) return reply.code(400).send({ error: '标题不能超过 100 字' });
    sets.push('title = :title');
    params.title = title;
  }
  const content = body.content?.trim();
  if (content !== undefined) {
    if (!content) return reply.code(400).send({ error: '内容不能为空' });
    if (content.length > MAX_NOTE_LENGTH) return reply.code(400).send({ error: `内容不能超过 ${MAX_NOTE_LENGTH} 字` });
    sets.push('content = :content');
    params.content = content;
  }
  if (body.category !== undefined) {
    if (!validCategories.includes(body.category)) return reply.code(400).send({ error: `category 必须是分类树路径（${validCategories.join(' / ')}）` });
    sets.push('category = :category');
    params.category = body.category;
  }
  if (body.kind !== undefined) {
    if (!validKinds.includes(body.kind)) return reply.code(400).send({ error: `kind 必须是 ${validKinds.join('/')}` });
    sets.push('kind = :kind');
    params.kind = body.kind;
  }
  if (body.valid_at !== undefined) {
    const va = body.valid_at ? body.valid_at.trim() : null;
    if (va && !/^\d{4}-\d{2}-\d{2}$/.test(va)) return reply.code(400).send({ error: 'valid_at 格式必须是 YYYY-MM-DD 或空' });
    sets.push('valid_at = :valid_at');
    params.valid_at = va;
  }
  if (body.entity_id !== undefined) {
    const eid = body.entity_id;
    if (eid !== null && (typeof eid !== 'number' || !getEntity(db, eid))) {
      return reply.code(400).send({ error: 'entity_id 必须是存在的实体 id 或 null' });
    }
    sets.push('entity_id = :entity_id');
    params.entity_id = eid;
  }
  if (!sets.length) return reply.code(400).send({ error: '没有可更新的字段' });

  sets.push("updated_at = datetime('now', 'localtime')");
  db.prepare(`update notes set ${sets.join(', ')} where id = ${noteId}`).run(params);

  // 向量重算：title/content 是向量文本（分类/时间不进向量）
  if (title !== undefined || content !== undefined) {
    const final = getNote(db, noteId)!;
    const [vec] = await embedder.embed([`${final.title}\n${final.content}`]);
    if (vec) upsertVector(db, noteId, Float32Array.from(vec));
  }

  const detail = getNoteDetail(db, noteId);
  return detail ?? reply.code(404).send({ error: 'note not found' });
});

// 记忆写入（M4"记下来"）：LLM 分类 + 向量化 + 演化判定 + 落库（1 次 embed + 2 次 LLM，需数秒）
// source 透传：'chat' = 对话建议卡片写入（激活 write-note 预留分支）；'manual' = 图书馆手动录入（默认）
app.post('/api/notes', async (req, reply) => {
  const body = req.body as { text?: string; title?: string; category?: string; kind?: string; valid_at?: string | null; source?: string };
  const text = (body?.text ?? '').trim();
  if (!text) return reply.code(400).send({ error: 'text 必填' });
  if (text.length > MAX_NOTE_LENGTH) return reply.code(400).send({ error: `text 不能超过 ${MAX_NOTE_LENGTH} 字` });
  const validKinds = ['experience', 'preference', 'reading_note', 'essay', 'decision', 'principle'];
  if (body?.kind && !validKinds.includes(body.kind)) return reply.code(400).send({ error: `kind 必须是 ${validKinds.join('/')}` });
  const va = body?.valid_at ? body.valid_at.trim() : null;
  if (va && !/^\d{4}-\d{2}-\d{2}$/.test(va)) return reply.code(400).send({ error: 'valid_at 格式必须是 YYYY-MM-DD 或空' });
  const source = body?.source === 'chat' ? 'chat' : 'manual';
  try {
    const result = await createNoteFromText(db, text, {
      source,
      title: body?.title?.trim() || undefined,
      category: body?.category || undefined,
      kind: body?.kind || undefined,
      validAt: va ?? undefined,
    });
    return { ok: true, result };
  } catch (err) {
    return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 导入：POST 创建 job 并同步分析（dry-run 报告）→ 确认后 commit 落库
// body: { sourceDir } 导入整个目录，或 { files: [...] } 导入指定文件
app.post('/api/import', async (req, reply) => {
  const body = req.body as { sourceDir?: string; files?: string[] };
  const sourceDir = body?.sourceDir;
  if (!sourceDir && !body?.files?.length) return reply.code(400).send({ error: 'sourceDir 或 files 必填' });
  const dir = sourceDir ?? '';

  let job;
  try {
    job = createImportJob(db, dir);
    const files = body.files?.length ? body.files : scanMemoryFiles(dir);
    const report = await analyzeImport(db, job.id, files);
    return { job: getImportJob(db, job.id), report };
  } catch (err) {
    if (job) setImportFailed(db, job.id, err);
    return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

function setImportFailed(db: import('@kbf/core').KbfDb, id: number, err: unknown): void {
  try {
    db.prepare("update imports set status = 'failed', report = ?, updated_at = datetime('now', 'localtime') where id = ?").run(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      id,
    );
  } catch {
    /* 忽略二次错误 */
  }
}

app.get('/api/import/:id', async (req, reply) => {
  const job = getImportJob(db, Number((req.params as { id: string }).id));
  if (!job) return reply.code(404).send({ error: 'job not found' });
  return job;
});

app.post('/api/import/:id/commit', async (req, reply) => {
  const report = await commitImport(db, Number((req.params as { id: string }).id));
  if (!report) return reply.code(409).send({ error: 'job 状态不可 commit（需 ready）' });
  return { ok: true, report };
});

// journal 归档模式：默认 locked（40 篇日志 archived，对话零注入）；
// unlocked 时恢复 active 可检索（历史模式）
app.get('/api/journal-mode', async () => ({ mode: getJournalMode(db) }));

app.post('/api/journal-mode', async (req, reply) => {
  const { mode } = (req.body ?? {}) as { mode?: string };
  if (mode !== 'locked' && mode !== 'unlocked') return reply.code(400).send({ error: 'mode 必须是 locked 或 unlocked' });
  const result = setJournalMode(db, mode);
  return { ok: true, mode, ...result };
});

// 分类树（M4 图书馆导航）：CATEGORY_TREE 静态结构，前端渲染树 + 本地计数
app.get('/api/categories', async () => ({ tree: CATEGORY_TREE }));

// LLM API 配置（2026-08-08）：key / baseUrl / model 三字段，写入 .env + 运行时 env
// 不锁死 DeepSeek：兼容 OpenAI 格式的任何端点（变量名沿用 DEEPSEEK_*，deepseek.ts 每次调用实时读取 → 立即生效）
// 安全：GET 不返回 key 值；key 只落 .env（硬约束：绝不入代码/日志/记忆）
app.get('/api/settings/llm', async () => ({
  configured: !!process.env.DEEPSEEK_API_KEY,
  baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
  model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
  format: process.env.LLM_API_FORMAT ?? 'openai',
}));

app.post('/api/settings/llm', async (req, reply) => {
  const body = req.body as { key?: string; baseUrl?: string; model?: string; format?: string };
  const k = (body.key ?? '').trim();
  if (k && (k.length < 20 || k.length > 200)) return reply.code(400).send({ error: 'key 长度异常（20-200 字符）' });
  const fmt = body.format;
  if (fmt !== undefined && fmt !== 'openai' && fmt !== 'anthropic' && fmt !== 'responses') {
    return reply.code(400).send({ error: 'format 必须是 openai / anthropic / responses' });
  }
  const envPath = path.join(ROOT, '.env');
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    /* .env 不存在则新建 */
  }
  const lines = content.split('\n');
  const updates: Array<[string, string]> = [];
  if (k) updates.push(['DEEPSEEK_API_KEY', k]);
  if ((body.baseUrl ?? '').trim()) updates.push(['DEEPSEEK_BASE_URL', body.baseUrl!.trim()]);
  if ((body.model ?? '').trim()) updates.push(['DEEPSEEK_MODEL', body.model!.trim()]);
  if (fmt) updates.push(['LLM_API_FORMAT', fmt]);
  for (const [name, value] of updates) {
    const idx = lines.findIndex((l) => l.startsWith(`${name}=`));
    if (idx >= 0) lines[idx] = `${name}=${value}`;
    else lines.push(`${name}=${value}`);
    process.env[name] = value; // deepseek.ts 实时读取，无需重启
  }
  fs.writeFileSync(envPath, lines.join('\n') + '\n');
  return { ok: true, configured: !!process.env.DEEPSEEK_API_KEY };
});

// 实体（2026-08-08 手动化）：列表（含笔记数）/ 创建（幂等，同 type+title 返回已有）
const ENTITY_TYPES = ['book', 'movie', 'music', 'game', 'place', 'person'];
app.get('/api/entities', async () => {
  const rows = db
    .prepare(
      `select e.id, e.uid, e.type, e.title, e.creator, e.year,
              (select count(*) from notes n where n.entity_id = e.id) as note_count
       from entities e order by e.type, e.title`,
    )
    .all() as Array<{ id: number; uid: string; type: string; title: string; creator: string | null; year: number | null; note_count: number }>;
  return { entities: rows };
});

app.post('/api/entities', async (req, reply) => {
  const body = req.body as { type?: string; title?: string; creator?: string; year?: number };
  if (!ENTITY_TYPES.includes(body?.type ?? '')) return reply.code(400).send({ error: `type 必须是 ${ENTITY_TYPES.join('/')}` });
  const title = (body?.title ?? '').trim();
  if (!title) return reply.code(400).send({ error: 'title 必填' });
  if (title.length > 100) return reply.code(400).send({ error: 'title 不能超过 100 字' });
  const id = createEntity(db, { type: body.type as 'book' | 'movie' | 'music' | 'game' | 'place' | 'person', title, creator: body.creator, year: body.year });
  return { ok: true, id, title, type: body.type };
});

// 备份导出（M4）：VACUUM INTO 生成 WAL 一致性快照 → 附件下载（快照保留在 data/backups/）
app.get('/api/export', async (_req, reply) => {
  const backupDir = path.join(ROOT, 'data', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const ts = new Date();
  const stamp = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}-${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}${String(ts.getSeconds()).padStart(2, '0')}`;
  const backupPath = path.join(backupDir, `kittilsen-${stamp}.db`);
  // VACUUM INTO 不接受绑定参数，路径由程序生成（无用户输入，无注入面）
  db.prepare(`vacuum into '${backupPath}'`).run();
  const filename = path.basename(backupPath);
  reply.header('Content-Type', 'application/octet-stream');
  reply.header('Content-Disposition', `attachment; filename="${filename}"`);
  return reply.send(fs.createReadStream(backupPath));
});

// 会话列表（侧边栏用）：首条 user 消息作摘要
app.get('/api/conversations', async () => {
  const rows = db
    .prepare(
      `select c.uid, c.title, c.updated_at,
              (select count(*) from messages m where m.conversation_id = c.id) as msg_count,
              (select content from messages m where m.conversation_id = c.id and m.role = 'user' order by m.id limit 1) as first_message
       from conversations c
       order by c.updated_at desc
       limit 50`,
    )
    .all() as Array<{ uid: string; title: string; updated_at: string; msg_count: number; first_message: string | null }>;
  return { conversations: rows };
});

// 历史消息（beta 会话恢复用）
app.get('/api/conversations/:uid/messages', async (req, reply) => {
  const { uid } = req.params as { uid: string };
  const conv = db.prepare('select id from conversations where uid = ?').get(uid) as { id: number } | undefined;
  if (!conv) return reply.code(404).send({ error: 'conversation not found' });
  const messages = db
    .prepare('select role, content from messages where conversation_id = ? order by id')
    .all(conv.id) as Array<{ role: string; content: string }>;
  return { conversationId: uid, messages };
});

// 会话标题：PATCH 修改（空标题 = 恢复默认，侧边栏回退显示首条消息摘要）
app.patch('/api/conversations/:uid', async (req, reply) => {
  const { uid } = req.params as { uid: string };
  const { title } = (req.body ?? {}) as { title?: string };
  const t = (title ?? '').trim();
  if (t.length > 50) return reply.code(400).send({ error: '标题不能超过 50 字' });
  const conv = db.prepare('select id from conversations where uid = ?').get(uid) as { id: number } | undefined;
  if (!conv) return reply.code(404).send({ error: 'conversation not found' });
  // 不更新 updated_at：排序保持"最后对话时间"，改标题不影响位置
  db.prepare('update conversations set title = ? where uid = ?').run(t, uid);
  return { ok: true, title: t };
});

// ── 对话：SSE 流（memory-planned → memory-injected → delta… → done）──
app.post('/api/chat', async (req, reply) => {
  const body = req.body as { conversationId?: string; message: string };
  if (!body?.message) return reply.code(400).send({ error: 'message 必填' });

  // 会话：有则复用，无则创建
  let convId: number;
  let convUid = body.conversationId ?? '';
  const existing = convUid ? (db.prepare('select id from conversations where uid = ?').get(convUid) as { id: number } | undefined) : undefined;
  if (existing) {
    convId = existing.id;
  } else {
    convUid = nanoid();
    convId = Number(
      db
        .prepare(
          "insert into conversations(uid, created_at, updated_at) values (?, datetime('now', 'localtime'), datetime('now', 'localtime'))",
        )
        .run(convUid).lastInsertRowid,
    );
  }

  // 存用户消息 + 读历史
  db.prepare("insert into messages(conversation_id, role, content, created_at) values (?, ?, ?, datetime('now', 'localtime'))").run(convId, 'user', body.message);
  const history = (db
    .prepare('select role, content from messages where conversation_id = ? order by id desc limit 8')
    .all(convId) as Array<{ role: string; content: string }>)
    .reverse();

  // 检索记忆
  const mem = await retrieveMemory(db, body.message, history.slice(0, -1));

  // 2026-08-23 记忆建议：长消息（≥SUGGEST_MIN_CHARS）才触发 LLM 判定，短消息零成本；
  // 与下方对话流并行执行（判定 ~1-3s vs 流式回复 ~5-15s，实际零尾延迟）；
  // suggestMemory 内部全兜底永不 reject，error 路径不 await 也不会有悬挂 rejection
  const suggestPromise: Promise<SuggestDecision> =
    body.message.trim().length >= SUGGEST_MIN_CHARS
      ? suggestMemory(body.message, history.slice(0, -1), listCategories(db))
      : Promise.resolve({ worth: false });

  // SSE 响应头
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event: string, data: unknown) => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('memory-planned', {
    needsMemory: mem.decision.needsMemory,
    queries: mem.decision.queries,
    mode: mem.decision.mode,
    emotional: mem.decision.emotional,
  });

  if (mem.memory && mem.injectedNotes.length) {
    send('memory-injected', {
      count: mem.injectedNotes.length,
      noteIds: mem.memory.noteIds,
      notes: mem.injectedNotes.map((n) => ({
        id: n.id,
        title: n.title,
        content: n.content,
        category: n.category,
        status: n.status,
        time: n.valid_at?.slice(0, 10) ?? null,
        identity: identityOf(db, n),
      })),
    });
  }

  // LLM 对话（流式）——#36 场景分级：system prompt 按 mode 强化（casual 克制 / analysis 呼应式）
  // 2026-08-23 零注入显式警告：无【用户 的记忆】段时禁止编造"你总是/你以前说"类过去断言（实测会伪造）
  const system = buildSystemPrompt(mem.decision.mode);
  const memoryBlock = mem.memory ? `\n\n【用户 的记忆（引用时遵守身份前缀规则）】\n${mem.memory.text}` : '';
  const noMemoryNote = mem.memory
    ? ''
    : `\n\n【注意】本轮没有注入任何记忆——你对 用户 的过去一无所知。禁止编造"你总是/你以前说过/你上次说过"等任何关于他过去的断言；拿不准就说"不太记得"。`;
  const messages = [
    { role: 'system' as const, content: system + memoryBlock + noMemoryNote },
    ...history.map((h) => ({ role: h.role as 'user' | 'assistant', content: h.content })),
  ];

  let full = '';
  try {
    full = await chatStream(messages, (delta) => send('delta', { text: delta }));
  } catch (err) {
    send('error', { message: err instanceof Error ? err.message : String(err) });
    reply.raw.end();
    return;
  }

  // 存 assistant 消息（含注入溯源）
  db.prepare(
    "insert into messages(conversation_id, role, content, injected_note_ids, created_at) values (?, ?, ?, ?, datetime('now', 'localtime'))",
  ).run(
    convId,
    'assistant',
    full,
    JSON.stringify(mem.memory?.noteIds ?? []),
  );
  db.prepare('update conversations set updated_at = datetime(\'now\', \'localtime\') where id = ?').run(convId);

  // 记忆建议事件：必须在 done 之前（await 保证顺序，连接关闭后事件丢失）
  const sg = await suggestPromise;
  if (sg.worth) {
    send('memory-suggest', {
      title: sg.title,
      category: sg.category ?? null,
      content: sg.content,
      kind: sg.kind ?? null,
      validAt: sg.validAt ?? null,
      reason: sg.reason ?? null,
    });
  }

  send('done', { conversationId: convUid, conversationDbId: convId });
  reply.raw.end();
});

const port = Number(process.env.SERVER_PORT ?? 8899);
await app.listen({ port, host: '0.0.0.0' });
