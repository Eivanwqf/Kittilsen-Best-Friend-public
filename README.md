# Kittilsen-Best-Friend (KBF)

> ⚠️ **当前还在 Alpha 版本**：核心功能可用，界面与功能仍在迭代中。尚未公测，欢迎来和我一起共建。

灵感来源于村上春树写的小说，包括《挪威的森林》《小城与不确定性的墙》《海边的卡夫卡》，里面都写到了一个共同的概念 —— 角色内心的图书馆。图书馆可以是隔离自己与外面世界的“墙”，也可以是贮藏在内心深处的一个预言，或是一个装置。图书馆不仅是一个物理空间，更连接着潜意识、记忆、创伤治愈与命运的出口。

我们所有人的内心世界，应该都分门别类地装着不同时期的自己所经历过的事件。

“人生不如意十有八九，能与人言常二三。”如果这样的话，这些隐没在我们内心的事情，就真的只能让自己知道吗？

村上的书中，伴随着主角内心的图书馆的揭开，其内部总会有一个属于自己的影子——图书馆管理员，去管理我们内心的记忆。那么，如果我们可以通过当前的LLM，去通过了解你经历的所有事情，进而把它当做自己的影子，在迷茫时可以给你梳理当前的situation。并且基于你的人生步伐，给你建议呢？

陪伴型记忆 Agent —— 一个**懂你的老朋友**。独立 Web 应用，数据全部存储在本地：RAG 记忆检索 + 分类图书馆 + 记忆演化追踪（A-MEM）+ 原子记忆 + 日志归档。

与它聊天时，它会检索你的记忆库来了解你、陪你、如实分析你；你讲了值得记住的故事，它会主动建议是否写入记忆图书馆。

## 记忆内容
- 事件、关系、个人特点、性格、认知、生活方式、情感、原则
- 挂载的实体有：地点、人物、书籍、影视、音乐等

这样就可以实现，通过与 Kittilsen 日常聊天时，如果提到了某个实体，可以自动注入记忆中，有关于这个实体的记忆（例如，看了一本书的读后感、和某某某一起去看的音乐节。）

## 功能

- 💬 **对话（RAG 记忆检索）**：LLM 规划器（需要记忆才检索）→ 混合检索（向量 + 全文 + 专名 + 实体）→ 图扩展 → 按场景分级注入（分析型/日常型）
- 🗂️ **记忆图书馆**：分类树导航 + "记下来"手动写入（自动分类 + 向量化 + 演化判定）
- 📝 **对话建议写入**：你讲了长故事（≥80 字），系统自动建议把这件事写入图书馆，确认后可编辑
- 🧬 **记忆演化（A-MEM）**：新记忆自动与旧记忆对比，产生 NEW / EXPAND / CONFLICT / EVOLVE，支持"已失效"标注与演化链
- 📅 **时间线**：按事实时间展示记忆，可逐条修正时间
- ⏳ **日志归档**：历史日志默认归档（不打扰），可切换"历史模式"解锁检索
- 📊 **设置**：LLM API 配置（OpenAI / Anthropic / Responses 三格式）、备份导出（SQLite 快照）

## 架构

```
packages/core      域层（TypeScript）：SQLite + sqlite-vec(1024维) + FTS5，
                   记忆规划/混合检索/演化判定/写入管线，LLM 客户端（多格式）
apps/server        Fastify API（:8899）：对话 SSE、记忆 CRUD、导入、备份导出
apps/web           Next.js 15（:3000）：图书馆/时间线/对话/设置
scripts/           e2e 回归、embedding 诊断、迁移工具
```

- 检索链路：`planner（需不需要记忆）→ hybrid（RRF 融合 4 通道）→ graph-expand（2-hop 语义门控）→ context-builder（身份前缀注入）`
- 记忆存储：SQLite 单文件 `data/kittilsen.db`（WAL），向量索引 + FTS 全文索引
- Embedding：`bge-m3`（ONNX，GPU 加速可选），Python sidecar 按需加载

## 依赖

| 依赖 | 版本要求 | 说明 |
|---|---|---|
| Node.js | ≥ 20 | npm workspace 项目 |
| Python | ≥ 3.10 | embedding sidecar（fastembed-gpu + transformers） |
| CUDA GPU | 可选 | 无 GPU 时自动回退 CPU（较慢） |
| 网络 | 初始化时需要 | 首次需下载模型（~2.3GB）；之后除 LLM API 外不联网 |

> ⚠️ **平台说明**：当前验证环境为 Linux x64（WSL2）。sqlite-vec 等原生模块在其他平台（macOS/Windows）可能需自行编译或预编译包支持。

## 快速开始

```bash
# 1. 安装 Node 依赖
npm install

# 2. Python embedding 环境（一键脚本：venv + 依赖 + bge-m3 ONNX 模型导出）
bash scripts/setup-embed.sh

# 3. 配置环境变量
cp .env.example .env    # 填入 LLM API Key（见下方）

# 4. 启动（server :8899 + web :3000）
npm run dev:all
```

打开 http://localhost:3000 —— 首次启动自动创建空数据库（schema 自动迁移，无需手工初始化；分类树在首次写入记忆时自动种入）。

### 初始化脚本做了什么

`setup-embed.sh` 依次：创建 `.python/venv` → 安装 `fastembed-gpu transformers optimum[exporters]` → 用 optimum 从 `BAAI/bge-m3` 导出 ONNX 模型到 `.python/models/BAAI--bge-m3/onnx`（含 `model.onnx(+data)` 与 tokenizer 文件，是 loader 要求的目录结构）。

- 无 CUDA GPU：`fastembed-gpu` 仍可安装，onnxruntime 自动回退 CPU（每次加载模型更慢，约数十秒）
- 若导出失败（网络/内存限制）：可将任意已导出的 bge-m3 ONNX 源放入 `.python/models/BAAI--bge-m3/onnx/` 目录

### 配置（.env）

```bash
DEEPSEEK_API_KEY=sk-...           # 必填：LLM API Key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
LLM_API_FORMAT=openai             # openai | anthropic | responses
SERVER_PORT=8899
```

也可以在 Web 设置页（/settings）直接填写并保存，无需重启。

## 测试

```bash
npx tsx scripts/e2e-check.ts   # 框架级回归（真实 LLM，2-5 分钟）
```

部分断言是锚点式的：仅当库里存在对应数据时才执行（空库自动跳过）。

## 隐私

- **数据全本地**：记忆、对话、向量全部存储在 `data/` 目录的 SQLite 单文件，不会上传。
- **唯一外联**：LLM API 请求（默认 DeepSeek）。API Key 只在 `.env` 中，不会被提交。
- `.gitignore` 已排除 `data/`、`.env*`、备份等所有敏感路径——本仓库是代码镜像，不含任何个人数据。

## 项目状态

- **当前**：alpha（手动录入记忆模式；导入管线仅作迁移工具）
- **路线图**：连续录入模式、embedding 常驻进程、记忆演化链可视化、时光机/每日回顾、统计洞察面板


<img width="1996" height="1863" alt="Lib" src="https://github.com/user-attachments/assets/6662ee42-fc99-4727-99f8-b200f7122d10" />

**图书馆记忆界面**

<img width="2282" height="1889" alt="Chronological" src="https://github.com/user-attachments/assets/0771c98c-67a9-4b42-acf7-2a7dc10abb6c" />

**按照发生的时间顺序进行排序**

<img width="1937" height="1802" alt="RelativeMemory" src="https://github.com/user-attachments/assets/e8703a1c-34e9-49c5-b722-70764692551e" />

**用向量KNN, 进行所有相似笔记的召回，进而对相关事件的画布进行扩充。**

<img width="2322" height="1842" alt="Chat" src="https://github.com/user-attachments/assets/147e6d78-e880-47ca-85ee-743b51f8b3b7" />

**最重要的，聊天界面。**


---

*本项目为个人项目镜像，主仓库私有开发，此公开仓库为代码展示。*
