// Kittilsen-Best-Friend 数据库 schema（SQLite + sqlite-vec + FTS5 trigram）
// 版本管理：PRAGMA user_version。迁移顺序即数组顺序，只追加不修改已发布版本。

export const SCHEMA_VERSION = 4;

export const MIGRATIONS: string[] = [
  // v1: 初始 schema
  `
  -- 实体（书/影/歌/游戏/人/地）——被引用对象，不是笔记
  create table if not exists entities (
    id         integer primary key autoincrement,
    uid        text not null unique,          -- nanoid
    type       text not null check(type in ('book','movie','music','game','place','person')),
    title      text not null,
    creator    text,                          -- 作者/导演/艺人
    year       integer,
    meta       text not null default '{}',    -- json: ISBN/封面/链接等
    created_at text not null default (datetime('now', 'localtime')),
    updated_at text not null default (datetime('now', 'localtime'))
  );

  -- 原子记忆笔记
  create table if not exists notes (
    id           integer primary key autoincrement,
    uid          text not null unique,        -- nanoid，对外 id
    title        text not null,
    content      text not null,               -- ≤300 字原子
    category     text not null,               -- 书架路径 'self/preferences/music'
    tags         text not null default '[]',  -- json array
    valid_at     text,                        -- 事实生效时间（可空=未知）
    recorded_at  text not null default (datetime('now', 'localtime')),
    confidence   real not null default 0.5,   -- 0~1
    source       text not null check(source in ('import','chat','manual','deduction')),
    source_ref   text,                        -- 旧文件名/来源引用
    status       text not null default 'active' check(status in ('active','superseded','archived')),
    superseded_by integer references notes(id),
    access_count integer not null default 0,
    entity_id    integer references entities(id),
    kind         text not null default 'experience' check(kind in
                   ('experience','preference','reading_note','essay','decision','principle')),
    created_at   text not null default (datetime('now', 'localtime')),
    updated_at   text not null default (datetime('now', 'localtime'))
  );
  create index if not exists idx_notes_category on notes(category);
  create index if not exists idx_notes_status on notes(status);
  create index if not exists idx_notes_valid_at on notes(valid_at);
  create index if not exists idx_notes_entity on notes(entity_id);

  -- 笔记间链接（双向插入）
  create table if not exists note_links (
    source_id  integer not null references notes(id),
    target_id  integer not null references notes(id),
    kind       text not null check(kind in ('related','supersedes','expand')),
    created_at text not null default (datetime('now', 'localtime')),
    primary key (source_id, target_id, kind)
  );
  create index if not exists idx_note_links_target on note_links(target_id);

  -- 演化事件审计（A-MEM）
  create table if not exists evolution_events (
    id         integer primary key autoincrement,
    note_id    integer not null references notes(id),
    type       text not null check(type in ('NEW','EXPAND','CONFLICT','EVOLVE')),
    prev_id    integer references notes(id),
    next_id    integer references notes(id),
    reason     text not null,                 -- 人话，UI 直接展示
    created_at text not null default (datetime('now', 'localtime'))
  );
  create index if not exists idx_evolution_note on evolution_events(note_id);

  -- 书架分类树
  create table if not exists categories (
    id         integer primary key autoincrement,
    path       text not null unique,          -- 'self/preferences/music'
    parent     text,                          -- 父路径，根为 null
    created_at text not null default (datetime('now', 'localtime'))
  );

  -- 导入 job 状态机
  create table if not exists imports (
    id          integer primary key autoincrement,
    uid         text not null unique,
    status      text not null default 'pending' check(status in
                  ('pending','analyzing','ready','committed','failed')),
    source_dir  text not null,
    stats       text not null default '{}',   -- json: 新建/扩展/冲突/EVOLVE 计数
    report      text,                         -- json: 逐条明细
    created_at  text not null default (datetime('now', 'localtime')),
    updated_at  text not null default (datetime('now', 'localtime'))
  );

  -- 对话与消息（注入溯源）
  create table if not exists conversations (
    id         integer primary key autoincrement,
    uid        text not null unique,
    title      text not null default '新对话',
    created_at text not null default (datetime('now', 'localtime')),
    updated_at text not null default (datetime('now', 'localtime'))
  );
  create table if not exists messages (
    id               integer primary key autoincrement,
    conversation_id  integer not null references conversations(id),
    role             text not null check(role in ('user','assistant')),
    content          text not null,
    injected_note_ids text not null default '[]',  -- json array，溯源
    created_at       text not null default (datetime('now', 'localtime'))
  );
  create index if not exists idx_messages_conv on messages(conversation_id);

  -- 设置
  create table if not exists settings (
    key   text primary key,
    value text not null
  );

  -- FTS5 trigram（中文 BM25 检索）
  create virtual table if not exists notes_fts using fts5(
    title, content, category,
    tokenize = 'trigram',
    content = 'notes',
    content_rowid = 'id'
  );
  -- 同步触发器
  create trigger if not exists notes_ai after insert on notes begin
    insert into notes_fts(rowid, title, content, category) values (new.id, new.title, new.content, new.category);
  end;
  create trigger if not exists notes_ad after delete on notes begin
    insert into notes_fts(notes_fts, rowid, title, content, category) values ('delete', old.id, old.title, old.content, old.category);
  end;
  create trigger if not exists notes_au after update on notes begin
    insert into notes_fts(notes_fts, rowid, title, content, category) values ('delete', old.id, old.title, old.content, old.category);
    insert into notes_fts(rowid, title, content, category) values (new.id, new.title, new.content, new.category);
  end;

  -- 向量表（1024 维，bge-m3）
  create virtual table if not exists notes_vec using vec0(
    v float[1024]
  );
  `,
  // v2: 已导入文件 hash（幂等）
  `
  create table if not exists imported_files (
    file      text not null,
    hash      text not null,
    import_id integer not null references imports(id),
    imported_at text not null default (datetime('now', 'localtime')),
    primary key (file, hash)
  );
  `,
  // v3: 时间字段合并（2026-08-05 用户决策）——记录时间（入库时刻）无信息量，
  // 只保留有效时间（事实时间）。无 valid_at 的笔记用记录时间日期占位，供用户逐条修正。
  // recorded_at 未被 FTS 触发器/索引/CHECK 引用，DROP COLUMN 安全（SQLite 3.35+）。
  `
  update notes set valid_at = date(recorded_at) where valid_at is null;
  alter table notes drop column recorded_at;
  `,
  // v4: 时区修正（2026-08-08）——SQLite datetime('now') 存 UTC，本地 GMT+8 差 8 小时。
  // 存量列转系统本地时区（localtime 修饰符）；新写入由代码显式 localtime（存量表 default 无法改）。
  `
  update notes set created_at = datetime(created_at, 'localtime'), updated_at = datetime(updated_at, 'localtime');
  update entities set created_at = datetime(created_at, 'localtime'), updated_at = datetime(updated_at, 'localtime');
  update note_links set created_at = datetime(created_at, 'localtime');
  update evolution_events set created_at = datetime(created_at, 'localtime');
  update categories set created_at = datetime(created_at, 'localtime');
  update imports set created_at = datetime(created_at, 'localtime'), updated_at = datetime(updated_at, 'localtime');
  update conversations set created_at = datetime(created_at, 'localtime'), updated_at = datetime(updated_at, 'localtime');
  update messages set created_at = datetime(created_at, 'localtime');
  update imported_files set imported_at = datetime(imported_at, 'localtime');
  `,
];
