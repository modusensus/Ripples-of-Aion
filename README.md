<p align="center">
  <img src="banner.png" alt="岁月涟漪 · Ripples of Aion banner" width="100%" />
</p>

<h1 align="center">⏳ 岁月涟漪 · Ripples of Aion</h1>

<p align="center">
  <a href="https://github.com/modusensus/Ripples-of-Aion/releases"><img src="https://img.shields.io/badge/version-0.5.0-ff69b4?style=flat-square" alt="version"></a>
  <a href="https://github.com/modusensus/Ripples-of-Aion/actions"><img src="https://img.shields.io/github/actions/workflow/status/modusensus/Ripples-of-Aion/test.yml?style=flat-square&label=CI" alt="CI"></a>
  <img src="https://img.shields.io/badge/tests-94%20passed-ff69b4?style=flat-square" alt="tests">
  <a href="https://codecov.io/gh/modusensus/Ripples-of-Aion"><img src="https://img.shields.io/codecov/c/github/modusensus/Ripples-of-Aion/main?style=flat-square&color=ff69b4&label=coverage" alt="coverage"></a>
  <img src="https://img.shields.io/badge/TypeScript-strict-ff69b4?style=flat-square&logo=typescript&logoColor=white" alt="typescript">
  <img src="https://img.shields.io/badge/node-22%2B-ff69b4?style=flat-square&logo=nodedotjs&logoColor=white" alt="node">
  <img src="https://img.shields.io/badge/platform-Cyrene%20Plugin%20API%20v1-ff69b4?style=flat-square" alt="platform">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-ff69b4?style=flat-square" alt="license"></a>
</p>

<p align="center"><strong><a href="#中文">中文</a> | <a href="#english">English</a></strong></p>

---

<a name="中文"></a>

# 🇨🇳 岁月涟漪（中文）

> **岁月无声，涟漪有痕** —— 你随口说过的每一件小事，都在时光的池塘里漾开涟漪；岁月涟漪把涟漪里的温度一一收好。等某天你回头，她都记得。

`岁月涟漪`（Ripples of Aion，插件 id `ripples-of-aion`）是一个 [Cyrene](https://github.com/Playa-0v0/Cyrene-Plugins) 插件，为昔涟提供**结构化记忆层**。它不是内置记忆引擎的替代品，而是一个并行记忆层：内置引擎对外只读，而它把每一轮对话中值得长期记住的事实**逐条沉淀、去重入库、混合检索、按需注入**。

## 💭 它能解决什么问题

Cyrene 的内置记忆（DMAE / 实体图谱 / RAG）不对插件开放写入，插件读不到内部向量库。岁月涟漪做内置没有的那一层：

| 场景 | 没有岁月涟漪 | 装了岁月涟漪 |
|------|-------------|-------------|
| 周一提过在准备考试，周四再聊 | 只能靠内置 L0/L2 碰运气 | 「你上周说每天复习到很晚，调整过来了吗？」 |
| 同一件事反复聊了十次 | 每次都可能重复入库 | 内容哈希去重，完全相同的事实只存一份 |
| 想知道「你对 X 的说法什么时候变过」 | 内置图谱只有 mentionCount | 实体属性时间轴 `valid_until`：属性变更自动闭合旧值 |

## ✨ 核心特性

- **逐事实沉淀** — 每轮对话由 LLM 抽取 0~N 条事实，每条独立成记忆记录，利于检索精度与时间轴
- **实体时间轴** — 抽取「会随时间变化的属性」声明（居住地、职业、宠物……），新值写入自动闭合旧值的 `valid_until`，「实体时间轴」工具可查任意属性的变更史
- **写入单收口** — 所有写入走唯一 `remember()`，内容哈希去重，事件重放不产生重复
- **混合检索** — 关键词召回打底 + 可选向量重排，权重向量 1.0 > 关键词 0.7；未配 embedding 自动降级纯关键词
- **fail-safe** — 抽取/向量化/存储任何一步失败只 warn 降级，绝不拖累聊天主流程
- **旁路队列** — `host:turn:finished` 是宿主不等的通知，全部重活在自建串行队列里做，全程尊重 `ctx.signal`
- **记忆图谱窗口** — 插件卡片「打开」弹出记忆面板，可浏览、可遗忘
- **人类可读存储** — JSONL 追加日志 + 内存索引，不上 native sqlite，崩溃只丢最后一行

## 📦 安装

```bash
# 方式一：本地开发机一键部署（构建 → 拷贝到 Cyrene 插件目录）
npm install
npm run deploy
# 然后在 Cyrene 插件面板「刷新插件」并手动启用

# 方式二：下载仓库构建产物压缩成 ZIP，从插件面板导入
```

> 需要 Node 22+。插件数据存于 `plugin-data/ripples-of-aion/`，卸载插件不丢记忆。

## 🔧 配置（可选）

装完即用（默认纯关键词检索）。要开语义检索时：

| 需求 | 配置项 | 默认值 | 改法 |
|------|--------|--------|------|
| 开启向量检索 | `embeddingProvider` | `none` | 改为 `openai-compatible` |
| Embeddings 端点 | `embeddingBaseUrl` | `https://api.openai.com/v1` | 任何 OpenAI 兼容地址 |
| 模型 | `embeddingModel` | `text-embedding-3-small` | 按端点支持的填 |
| API Key | `ctx.deps.secrets` 中的键名 | `embedding_api_key` | 用宿主安全存储，不落代码 |

## 🧪 测试与质量保障

全量测试基于 vitest，契约测试**直接加载构建产物**——测的就是要发布的东西。

| 套件 | 用例 | 覆盖内容 |
| --- | --- | --- |
| `tests/store.test.ts` | 11 | JSONL 重放恢复、内容哈希去重、软删隔离、轮次永久标记、关键词排序、统计、空内容边界、时间轴闭合/去噪/软删隔离/重放持久 |
| `tests/queue.test.ts` | 5 | 串行顺序、抛错不阻塞、signal 中止丢弃排队、signal 透传、已中止入队放行 |
| `tests/pipeline.test.ts` | 7 | 逐事实入库带溯源、同轮重复摄入去重、坏 LLM 输出跳过、空消息边界、队列串行摄入、claims 挂载对应事实、旧格式无 claims |
| `tests/extractor.test.ts` | 6 | 对象格式解析、旧格式兼容、栅栏/夹带文字容忍、坏 claim 逐条丢弃、claims 上限截断、完全不可解析 |
| `tests/tools.test.ts` | 9 | 工具空态与降级提示、hybrid 排序/过滤语义、直通精排、hot-context 预算注入与中止、时间轴当前值/历史/属性过滤 |
| `tests/contract.test.ts` | 3 | 产物契约（工具前缀/provider/IPC/订阅/dispose）、recall 空态、unregister 幂等 |

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest 全量测试
npm run build       # esbuild 打包 + 记录源码哈希
npm run check-sync  # prepack 闸门：源码变了产物没重建会 exit 1
```

## 🛡️ 设计约束（踩坑沉淀）

- `host:turn:finished` 宿主超 5 秒只记日志——监听器里只投队列，不 await 重活
- `finalMessageId` 只有桌面成功终态才有，非成功终态绝不自己补
- 读消息用 `inputMessageId`/`finalMessageId` 冻结边界分页，翻页不混轮次
- prompt provider 单项 ≤16000 字符、并行、2 秒上限——注入只放短事实，预算自检
- 工具 id 必须 `<插件id>_` 前缀；错误只按稳定错误码分支
- Cyrene-Plugins 收录编译产物：prepack 强制 check-sync，杜绝「改了 TS 忘了构建」的静默失效

## 🗺️ 路线图

```
🫧 骨架与纵切（v0.1.0）→ 🕸️ 实体时间轴（v0.2.0）→ 🌡️ 主观 heat（v0.3.0）→ 💤 autoDream 整合（v0.4.0）→ 🖥️ 面板大改版（v0.5.0）→ ✨ 精排与图谱增强（v0.6.0）→ 🌉 CyreneCore Memory API 对接（长期）
```

| 版本 | 主题 | 状态 |
|------|------|------|
| **v0.1.0** | 骨架 + 最小纵切：写入收口 / 混合检索 / 注入 / 三工具 / 窗口 / CI | ✅ |
| **v0.2.0** | 实体抽取 + `valid_until` 属性时间轴 + 时间轴工具 + 面板改版 + id 更名 | ✅ |
| **v0.3.0** | 主观 heat 衰减（检索命中/同实体提及加权）+ 热上下文轻量化（关键词 only）+ 属性别名归一化 + moments-post 注入 | ✅ |
| **v0.4.0** | autoDream 空闲整合：主题聚类 + 矛盾标注（标注型，不改写原记忆）+ 启动补跑 | ✅ |
| **v0.5.0** | 图谱窗口大改版：三页导航（记忆/状态/设置）+ autoDream 沉淀页（主题簇/矛盾/立即做梦）+ 面板设置页 + 左右扩展布局 | ✅ |
| **v0.6.0** | LLM rerank 精排 + 记忆图谱可视化 + 检索台 | 🚧 |
| **长期** | 对接 CyreneCore Memory API（能力清单见 [docs/memory-api-wishlist.md](docs/memory-api-wishlist.md)） | 📋 |

**与 CyreneCore 的分工**（2026-09 与维护者达成的共识，见 [Cyrene-Plugins#1](https://github.com/Playa-0v0/Cyrene-Plugins/issues/1)）：核心将沿 LLM Wiki 思路提供通用、稳定的记忆基础设施（客观知识页）；岁月涟漪专注**伴侣式主观记忆层**——heat、时间轴、自动整理、可视化与更具角色感的记忆策略。v0.3/v0.4 按自有存储推进；待核心 Memory API 定型后逐步迁移到公共接口，两者不互斥。

## 🛠️ 本地开发

```bash
npm install
npm run typecheck
npm test           # 94 个测试
npm run build
npm run deploy     # 构建并安装到本机 Cyrene
```

## 🙏 贡献者

感谢每一位为岁月涟漪贡献过代码的伙伴：

| 贡献者 | 贡献内容 |
|------|------|
| [@Playa-0v0](https://github.com/Playa-0v0) | 面板无外框窗口 + 自绘标题栏 + 底部白带修复（v0.4.1） |

## 📜 License

MIT

---

<a name="english"></a>

# 🇬🇧 Ripples of Aion (English)

> **Time says nothing; the ripples remember.** — Every little thing you let slip stirs a ripple across the pond of time. Ripples of Aion gathers what the ripples leave behind — softly and faithfully, the way someone keeps the small things you never thought mattered.

Ripples of Aion (岁月涟漪, plugin id `ripples-of-aion`) is a [Cyrene](https://github.com/Playa-0v0/Cyrene-Plugins) plugin that provides a **structured memory layer** for the companion. It is not a replacement for the built-in memory engine but a parallel memory layer: the engine is read-only to plugins, while this plugin settles each turn's memorable facts **record by record — deduplicated, hybrid-searchable, and injected on demand**.

## 💭 What it does

Cyrene's built-in memory (DMAE / entity graph / RAG) is not writable by plugins, and plugins cannot query its internal vector store. Ripples of Aion builds the layer the engine doesn't offer:

| Scenario | Without Ripples of Aion | With Ripples of Aion |
|------|-------------|-------------|
| You mention exam prep on Monday, chat again on Thursday | Built-in L0/L2 recall is hit-or-miss | "You said last week you were studying late — is that any better now?" |
| The same topic comes up ten times | Every occurrence may be stored again | Content-hash dedup: identical facts are stored exactly once |
| "When did your answer about X change?" | Built-in graph only has mentionCount | Entity attribute timeline with `valid_until`: old values auto-close when a new one lands |

## ✨ Core Features

- **Per-fact records** — each turn yields 0~N LLM-extracted facts, each stored as an independent memory record for retrieval precision and timelines
- **Entity timelines** — claims about *time-varying* attributes (residence, job, pets…) are extracted alongside facts; writing a new value auto-closes the old one's `valid_until`, and the timeline tool answers "what changed, and when"
- **Single write gate** — every write goes through one `remember()` with content-hash dedup; event replays produce no duplicates
- **Hybrid retrieval** — keyword recall as the floor + optional vector rerank, weighted vector 1.0 > keyword 0.7; degrades to keyword-only when embeddings are unconfigured
- **Fail-safe** — extraction, embedding, and storage failures only warn and degrade; the chat flow is never blocked
- **Bypass queue** — `host:turn:finished` is a notification the host won't wait for; all heavy work runs in a self-managed serial queue that respects `ctx.signal`
- **Memory graph window** — the plugin card's "open" button pops a memory panel for browsing and forgetting
- **Human-readable storage** — JSONL append-only journal + in-memory index; no native sqlite; a crash loses at most the last line

## 📦 Install

```bash
# Option A: one-command local deploy (build + copy into Cyrene's plugin dir)
npm install
npm run deploy
# then hit "Refresh plugins" in Cyrene's plugin panel and enable manually

# Option B: download the built artifact from CI, zip it, and import from the plugin panel
```

> Requires Node 22+. Plugin data lives in `plugin-data/ripples-of-aion/`; uninstalling the plugin keeps your memories.

## 🔧 Configuration (Optional)

Works out of the box (keyword-only retrieval). To enable semantic search:

| Need | Config key | Default | Change |
|------|-----------|---------|--------|
| Enable vector retrieval | `embeddingProvider` | `none` | Set to `openai-compatible` |
| Embeddings endpoint | `embeddingBaseUrl` | `https://api.openai.com/v1` | Any OpenAI-compatible URL |
| Model | `embeddingModel` | `text-embedding-3-small` | Whatever your endpoint serves |
| API Key | key name inside `ctx.deps.secrets` | `embedding_api_key` | Stored in the host secure store, never in code |

## 🧪 Testing & Quality

Tests run on vitest; the contract suite **loads the built artifact directly** — it tests exactly what ships.

| Suite | Cases | Coverage |
| --- | --- | --- |
| `tests/store.test.ts` | 11 | JSONL replay, content-hash dedup, soft-delete isolation, permanent turn markers, keyword ranking, stats, empty-content edge, timeline close/dedupe/soft-delete/persistence |
| `tests/queue.test.ts` | 5 | Serial order, error isolation, abort drops pending, signal passthrough, enqueue-after-abort |
| `tests/pipeline.test.ts` | 7 | Per-fact ingestion with provenance, duplicate-turn dedup, malformed LLM output skip, empty-message edge, queued serial ingestion, claim attachment, legacy format without claims |
| `tests/extractor.test.ts` | 6 | Object-format parsing, legacy array compat, fence/prose tolerance, per-claim rejection, claim cap, fully unparseable input |
| `tests/tools.test.ts` | 9 | Tool empty-state fallbacks, hybrid ranking/filter semantics, passthrough rerank, hot-context budget injection and abort, timeline current/history/attribute filter |
| `tests/contract.test.ts` | 3 | Artifact contract (tool prefix / provider / IPC / subscription / dispose), recall empty state, unregister idempotency |

```bash
npm run typecheck   # tsc --noEmit
npm test            # full vitest suite
npm run build       # esbuild bundle + record source hash
npm run check-sync  # prepack gate: stale artifact fails with exit 1
```

## 🛡️ Design Constraints (Lessons Baked In)

- `host:turn:finished` is cancelled beyond 5s — the listener only enqueues; heavy work never runs inline
- `finalMessageId` exists only on desktop success-terminal turns; never fabricated otherwise
- Messages are read with `inputMessageId`/`finalMessageId` frozen-boundary pagination; page turns never mix turns
- Prompt provider: ≤16000 chars per item, parallel, 2s cap — inject short facts only, with a self-checked budget
- Tool ids must use the `<plugin-id>_` prefix; errors branch on stable error codes only
- Cyrene-Plugins indexes the compiled artifact: prepack enforces check-sync, killing the "edited TS but forgot to rebuild" silent-failure class

## 🗺️ Roadmap

| Version | Theme | Status |
|------|------|------|
| **v0.1.0** | Skeleton + minimal vertical slice: write gate / hybrid retrieval / injection / three tools / window / CI | ✅ |
| **v0.2.0** | Entity extraction + `valid_until` attribute timeline + timeline tool + panel redesign + id rename | ✅ |
| **v0.3.0** | Subjective heat decay (access/mention boost) + lightweight hot context (keyword-only) + attribute alias normalization + moments-post injection | ✅ |
| **v0.4.0** | autoDream idle consolidation: topic clustering + conflict annotation (annotation-only, memories never rewritten) + catch-up on boot | ✅ |
| **v0.5.0** | Panel redesign: three-page nav (memory / insights / settings) + autoDream insights page + in-panel settings + wider layout | ✅ |
| **v0.6.0** | LLM rerank + memory graph visualization + search bench | 🚧 |
| **Long term** | Integrate with the CyreneCore Memory API (capability wishlist in [docs/memory-api-wishlist.md](docs/memory-api-wishlist.md)) | 📋 |

**Division of labor with CyreneCore** (consensus reached with the maintainer in 2026-09, see [Cyrene-Plugins#1](https://github.com/Playa-0v0/Cyrene-Plugins/issues/1)): the core will provide generic, stable memory infrastructure along the LLM Wiki direction (objective knowledge pages); Ripples of Aion focuses on the **companion-flavored subjective memory layer** — heat, timelines, auto-consolidation, visualization, and more characterful memory strategies. v0.3/v0.4 continue on private storage; once the core Memory API settles, migration to the public interface can happen gradually — the two are not mutually exclusive.

## 🛠️ Local Development

```bash
npm install
npm run typecheck
npm test           # 94 tests
npm run build
npm run deploy     # build + install into local Cyrene
```

## 🙏 Contributors

Thanks to everyone who contributed code to Ripples of Aion:

| Contributor | Contribution |
|------|------|
| [@Playa-0v0](https://github.com/Playa-0v0) | Frameless panel window + custom titlebar + bottom white-band fix (v0.4.1) |

## 📜 License

MIT
