# Kittilsen-Best-Friend 开发交接

2026-08-03 迁移至此。**本文件是开发会话的权威上下文**。

## 项目定位

陪伴型记忆 Agent（"懂他的老朋友"）——独立 Web 应用：RAG 记忆检索 + 分类图书馆 + 演化追踪（A-MEM）+ 日志归档。用户 用户，数据全本地，唯一外联 DeepSeek API。

**当前进度**：M0-M4 + #36/#37 完成。数据：active 74 / superseded 5 / archived 62（40 日志 + 22 碎片）。e2e 18 项 PASS。

## 架构速览

```
packages/core（域层，TS 源码直接 import）
  ├─ db/：SQLite(better-sqlite3) + sqlite-vec(1024维) + FTS5 trigram，单文件 data/kittilsen.db（WAL）
  ├─ notes/：notes/entities/detail/write/journal-mode（三态：active/superseded/archived）
  ├─ import/：markdown-parser（frontmatter 优先：category/kind/maxlength/valid_at）、
  │           classifier（LLM 分类）、importer（幂等 + 数据更新）、categories（分类树 20 条）
  ├─ retrieval/：planner（LLM：needsMemory/queries/timeWindow/mode/emotional，前任人名确定性覆盖）
  │           → hybrid（4 通道 RRF：dense KNN + BM25 + LIKE + 实体名双向 LIKE；journal ×0.25、关系簇 ×0.5 + 去重）
  │           → graph-expand（链接 2-hop 语义门控 + 实体扩展；casual 模式跳过）→ context-builder（身份前缀注入，buildSystemPrompt 按 mode 分级）
  │           + suggest（对话建议：≥80 字长消息 LLM 判定值得写入 → memory-suggest 事件；永不 reject）
  ├─ evolution/：classify（NEW/EXPAND/CONFLICT/EVOLVE；experience/reading_note 永不 supersede）
  ├─ llm/：deepseek.ts（chat/chatJson/chatStream，运行时读 env；三格式：openai 默认/anthropic/responses，LLM_API_FORMAT 切换）
  └─ embed/：SidecarEmbedder → scripts/embed-env.sh → venv python → bge_m3_loader.py（GPU，按需 spawn ~2s）
apps/server（Fastify :8899）：/api/notes（GET 列表 subtree 匹配 / GET 详情 / PATCH 编辑含实体挂载 / POST 写入"记下来"） /api/import /api/chat(SSE) /api/journal-mode /api/conversations（含 PATCH 改标题） /api/categories（分类树） /api/entities（列表/创建，手动化） /api/export（VACUUM INTO 快照下载，存 data/backups/）
apps/web（Next.js :3000）：统一导航（layout），图书馆(/)（分类树侧栏 + 记下来弹窗） / 时间线(/timeline) / 设置(/settings：journal 模式 + 统计 + 备份导出) / 对话(/chat，⏳历史模式开关) / 笔记详情(/notes/[id]，演化链)；共享纯函数在 components/shared.ts（无 'use client'，server/client 都可导入）
scripts/：e2e-check.ts（18 项）、docx2md.py（docx→md，有越界写入防御）、embed-check.ts、migrate-exes.ts（exes 迁移，幂等可重跑）
```

## 核心机制（改代码前必读）

1. **注入格式**：active 全文注入（`身份前缀[时间] 标题：内容`，≤2500 字）；superseded 仅 60 字摘要+【已失效】；身份前缀 📚读过/✍️写过/🧠经历过/⏳过往（archive/journal→past）
2. **归档模式**：settings.journal_mode（locked 默认）→ 40 篇日志 status=archived（检索/列表/图扩展全排除）；unlocked → active（带 ⏳+降权）。**journal 不经过 LLM 分类**（frontmatter 写死 archive/journal），不在分类树
3. **数据更新**：改源记忆文件 → 重导入 → 同源同标题内容不同则 UPDATE（含向量）；相同幂等跳过；hash 相同则被 imported_files 拦（需清记录）
4. **演化链**：主链 = notes.superseded_by；evolution_events 审计（EVOLVE 带 prevId）
5. **检索排序**：RRF 得分序（superseded 沉底，不按时间重排）；时间窗过滤（planner timeWindow，YYYY-MM，空则回退）；关系簇（第N任相处对象）降权+去重
6. **场景分级 + exes 门控（2026-08-05）**：planner 输出 mode(analysis/casual) + emotional:bool。analysis → 8 条注入 + 图扩展 + 呼应式；casual → top1 克制（≤1 条，跳图扩展）。emotional:false → retriever 两道过滤排除 life/relationships/exes（种子 + 图扩展后）；**确定性覆盖**：消息含前任人名（实体表 join exes 分类/簇正则标题，含 2字符 ASCII 短名守卫）或"第N任" → 强制 emotional:true，不依赖 LLM 判定。buildSystemPrompt(mode) 含规则 6 引用真实性硬规则（无注入依据明说"不记得"，绝不编造）

## 待办（按优先级）

- ✅ **对话建议写入**（2026-08-23 完成）：retrieval/suggest.ts 判定长消息（≥80 字，短消息零成本）→ SSE memory-suggest（与对话流并行，done 前发）→ chat 建议卡片（忽略/写入后本会话不再建议）→ WriteNoteModal 提取共享（initial 预填 + source:'chat' → source_ref 落 chat）。e2e 23/23
- ✅ **零注入防编造**（2026-08-23 完成）：buildSystemPrompt 前置【记忆注入】双分支（无注入段 = 对过去一无所知，禁"你总是/你以前说"类断言）+ 认错机制；server 零注入时追加显式警告段。e2e 19/19
- ✅ **#36 记忆调用场景分级**（2026-08-05 完成）：planner 输出 mode(analysis/casual)；分析型大量注入+呼应式；日常型克制（≤1 条）；引用真实性规则入 buildSystemPrompt 规则 6
- ✅ **#37 前任区门控**（2026-08-05 完成）：life/relationships/exes（迁移 10 条：31/32/33/34/35/60/97/98/99/100；52/55 女主人域与 41/46/48/63 家人关系不归）；emotional:false 排除；前任人名确定性覆盖。与 #36 合并设计（planner 一次升级）
- ✅ **M4**（2026-08-05 完成）：图书馆分类树导航（/api/categories + listNotes 子树匹配 + 侧栏树）、时间线 UI（/timeline）、设置页（/settings）、备份导出（/api/export，VACUUM INTO 快照留 data/backups/）、记忆写入（POST /api/notes + 图书馆"记下来"弹窗，write-note.ts 已接入导出）
- ✅ **记忆编辑**（2026-08-05 完成）：PATCH /api/notes/:id 逐条修正 title/content/category/kind/valid_at（content/title 变更自动重算向量，FTS 触发器同步；valid_at 修正时间线）；详情页 ✏️ 编辑弹窗（只提交变更字段）；会话侧边栏 + 自定义标题（PATCH /api/conversations/:uid）
- ✅ **实体手动化**（2026-08-08 完成，架构方向：导入是临时梯子，终态全手动/自动迭代）：GET/POST /api/entities（幂等创建）+ PATCH entity_id 挂载/解除；编辑弹窗实体下拉 + "＋新建"（type+title）；identityOf 补 reading_note → 📚（不依赖实体挂载）
- ✅ **LLM 多格式支持**（2026-08-08 完成）：deepseek.ts 三格式（openai chat/completions 默认 / anthropic /v1/messages / responses /v1/responses），LLM_API_FORMAT 切换（.env + 设置页下拉）；设置页可配 key/baseUrl/model/format，保存即生效；mock 验证三格式请求构造 + e2e 19/19
- ✅ **时间字段合并**（2026-08-05 完成，schema v3）：recorded_at（入库时刻，无信息量）删除，只留 valid_at（事实时间）。迁移：无 valid_at 的笔记用记录时间日期占位（UPDATE + DROP COLUMN，FTS/索引不受影响），用户逐条修正后时间线归位。当前 100 条占位 2026-08-01 待修正
- 用户计划 M4 后**手动重新录入所有原子记忆**（导入管线是临时搬家工具，终态是自己写入+维护；"记下来"与对话建议卡片已是写入入口）
- embedding 常驻进程（消灭 ~2s spawn 延迟，用户试过未成）
- 连续录入模式：记下来弹窗保存后不关闭、清空继续录（2026-08-23 用户选择过，未实现）

## 关键坑（防重踩）

- sqlite-vec 0.1.9：参数化 rowid 有 bug → rowid 字面量拼 SQL；**vec0 度量是 L2 不是余弦**（阈值 0.95）
- FTS5：match 用位置参数 ?（@q 静默空）；**数字开头 bareword 报 no such column**（如"2023"）→ 数字 token 双引号短语化 + try/catch 降级
- onnxruntime CUDA OOM：attention O(batch×seq²)——embed() 按 token 总量分批（max_tokens_per_batch=4000）
- upsertVector 是 delete+insert（vec0 已存在 rowid 直接 insert 报 UNIQUE）
- docx 转换安全：**输出路径必须展开后在输出目录内**（曾因 os.path.join 绝对路径覆盖源文件 41 篇事故）
- 深层：context 排序曾按时间重排吞掉检索得分 → 现在保持 RRF 序
- embedding spawn 每次加载模型 ~2s：检索/导入都慢，测试时耐心

## 用户硬约束

1. **绝不碰 /mnt 分区**（任何文件操作仅限项目目录内；源 docx 在项目 文章随笔/ 只读）
2. **所有 rm 指令需用户批准**
3. **DeepSeek API key 只在 .env**（（见 .env）），绝不写入记忆/代码/提交
4. 准确优先：不确定标不确定，先查后说，改文件先 Read 最新版
5. git 本地仓库（已有 8+ commits），改完一个功能点就 commit

## 发布流程（public 镜像）

```bash
bash scripts/sync-public.sh   # 一键发布：复制 + 脱敏 + 扫描 + 副本 commit + push（凭据缺失时提示手动推）
```

- 主仓库纯本地自用（不推 GitHub）；public 副本在 `<项目路径>-public`，每次功能完成即发布
- 副本保留清单（KEEP 数组，防覆盖/防删）：README.md、scripts/setup-embed.sh、scripts/sync-public.sh、packages/core/src/db/client.ts（副本版含 mkdir 改进）
- **新增敏感词**（人名/路径/项目代号）→ 加到 sync-public.sh 的 SENSITIVE 数组（key 模式匹配，不写真实值）；新增副本独有文件 → 加到 KEEP
- push 凭据问题：`cd <项目路径>-public && git push origin main`（GitHub PAT）

## 常用命令

```bash
npm run dev          # server :8899（tsx watch）
npm run dev:web      # web :3000（next dev，/api 代理到 8899）
npx tsx scripts/e2e-check.ts   # 18 项回归
npx tsx scripts/migrate-exes.ts   # exes 迁移（幂等，可重跑）
.python/venv/bin/python scripts/docx2md.py 文章随笔 data/docx-import/ --exclude 知乎 --maxlength 3500  # 日志转换
curl -X POST localhost:8899/api/journal-mode -d '{"mode":"locked"}'  # 归档模式切换
```
