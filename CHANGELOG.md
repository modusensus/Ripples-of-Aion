# Changelog

本插件遵循 [SemVer](https://semver.org/lang/zh-CN/)。版本号三段式由 `manifest.json`
与 `package.json` 同步维护——发布前跑 `npm run check-sync` 防止产物静默失效。

## [0.4.1] - 2026-09-09

### 变更

- 面板改为无外框窗口：粉色 UI 不再被系统原生灰框打断；顶部自绘标题栏整条可
  拖动（关闭按钮单独豁免拖动区，双击走系统默认最大化/还原），原标题行融入
  标题栏省出一行纵向空间
- 本版本界面改动由 Cyrene 仓库维护者 Playa-0v0 贡献（[PR #12](https://github.com/modusensus/Ripples-of-Aion/pull/12)）

### 修复

- 页面底部白带：`body` 的 `min-height` 在 `border-box` 下比视口矮 42px，
  渐变背景被截断后按平铺重复露出近白底色；改为正好 `100vh`

### 兼容性

- 纯界面层改动，数据格式不变；无外框窗口的移动/缩放仍走 v0.3.1 的
  窗口边界持久化
- 仓库基建：CI 检查名固定为 `test`，与 main 分支 ruleset 的必需检查上下文
  对齐（此前所有 PR 都会被永久 BLOCKED，直推 main 不受影响）

## [0.4.0] - 2026-09-08

### 新增

- autoDream 空闲整合（设计借鉴同作者的 dsh-mneme，裁定为**标注型整合**——只产出
  派生洞察，绝不改写/删除原记忆）：最后一轮摄入静默 30 分钟（可配）后自动运行，
  与摄入共用同一条串行队列（single-flight 不并发）；插件启动时若从未整合或已超
  空闲间隔，启动稳定 2 分钟后自动补跑，全程 fail-safe 只 warn
- 主题聚类：实体共现连通分量 + embedder 可用时的簇心余弦校验（< 0.5 摘出），
  LLM 一次批量调用为各簇命名；记录按有效热度降序选取（常被想起的优先参与），
  单次上限 80 条
- 冲突标注：同实体/同簇候选对（上限 40）预过滤——属性时间轴已闭合的旧值不算
  矛盾；LLM 判定矛盾对与摘要，evidence 强校验防伪造（序号越界/自引用/空摘要
  单条跳过、其余照常），候选对以两记录热度之和优先
- 洞察存储：`Insights`（主题簇 + 矛盾标注）落插件存储的派生键，可随时从记忆
  日志重算，不写记忆 journal（不触碰写入收口规则）；面板 get-state 通道露出
  摘要（簇标签+条数、矛盾摘要，各前 8 条），UI 渲染留待界面扩展

### 变更

- 新增配置 `consolidationEnabled`（默认 true）、`consolidationIdleMinutes`（30）、
  `consolidationMaxRecords`（80）

### 兼容性

- 纯后台能力：不开启任何新用户可见界面，面板渲染在后续版本扩展；旧库数据
  无需迁移，LLM 未配置或调用失败时空闲整合静默跳过、下个空闲窗口重试
- 测试 63 → 89 用例：insights +6、consolidate +19、契约 +1（套件 7 → 9）

## [0.3.1] - 2026-09-08

### 变更

- 面板空间升级：默认尺寸 460×640 → 720×900，新增最小尺寸（560×620）防止
  挤爆布局；实体时间轴与最近记忆在宽视口下并排两栏（窄视口自动回落单列）
- 窗口大小与位置持久化：拖动/缩放停止后落盘到插件存储，重开恢复上次布局；
  坏数据回退默认值，已断开显示器上的越界窗口收敛回可见范围（标题栏可抓取），
  最大化状态不落盘

### 兼容性

- 纯 UI 层改动，存储与数据格式不变；`src/ui/bounds.ts` 为纯函数收敛逻辑，
  独立单测覆盖（测试 57 → 63 用例，套件 6 → 7）

## [0.3.0] - 2026-09-08

### 新增

- 主观 heat 记忆热度：`MemoryRecord` 新增 `heat` / `lastTouchedAt`，检索时惰性计算
  指数时间衰减（默认约两周衰半，`heatDecayPerDay` 可调），常被想起的自然浮前、
  长期不用的自然沉底；检索命中（热上下文注入 / recall / search 工具）与
  「新记忆提及同实体」都会让热度向 1 靠拢一档，30 分钟节流防止日志暴涨，
  落盘走既有 put op 追加模式，重放一致；混合检索两条路径的最终分都乘热度增益
  （`heatWeight` 默认 0.5）
- moments-post 场景注入（随宿主 Cyrene-Agent#75 落地）：热记忆 Provider 显式声明
  `sources: ["conversation", "scheduler", "moments-post"]`，昔涟主动发动态时同样
  注入相关记忆；记忆保持全局、不按会话过滤——跨聊天记忆正是本插件的核心能力
- 属性别名归一化：新增 `src/core/attributes.ts` 的 `canonicalAttr()`（trim / 全角
  转半角 / 去空白 + 19 条确定性别名映射），claim 比较与时间轴分组一律看 canonical
  形式，`getEntityTimeline` 返回的声明保留原始字面量；抽取 prompt 加入固定属性
  词表（12 项）引导 LLM 稳定选词

### 修复

- 属性时间轴因 LLM 属性字面量漂移而漏闭合/重复分轨（实测「工作所在地」vs
  「工作地点」并存、「出差行程」vs「行程」重复）：归一化后存量旧字面量无需
  迁移即可被新声明正确闭合，重述去重跨别名生效

### 变更

- 热上下文轻量化：每轮注入不再调用 embedding API（纯关键词检索），显著降低
  首字延迟；向量检索只保留给 `ripples-of-aion_search` 工具
- 新增可选配置 `heatDecayPerDay`（默认 0.05）、`heatWeight`（0.5）、`heatBump`（0.15）

### 兼容性

- v0.2.0 库数据无需迁移：heat 缺省按中性 0.5 参与，旧字面量 claim 在比较时
  现归一；未配置新字段时走内置默认值
- 测试 41 → 57 用例：store +13（热度 5 + 别名归一 8）、extractor +2、tools +1

## [0.2.0] - 2026-09-07

### 新增

- 实体抽取：turn 摄入时 LLM 同时抽取事实与「会随时间变化的属性」声明
  （`entityClaims`），每条声明挂到其来源事实的记录上，`validFrom` 取摄入时间；
  旧格式纯数组输出照常兼容，解析器对栅栏/夹带文字/坏 claim 逐条容错
- 属性时间轴闭合：新 claim 写入时自动把同 (entity, attribute) 的旧活跃 claim
  的 `validUntil` 闭合为新记录的 `createdAt`（追加 put op 更新，重放保持一致）；
  闭合失败只 warn，查询侧按「最新者为准」兜底，绝不影响新记录落盘
- 时间轴去噪：与既有活跃 claim 完全相同（entity/attribute/value）的新声明
  不入库不闭合，重述同一属性不制造时间轴噪音；软删记录的 claim 不参与闭合
- 第 4 个 AI 工具 `ripples-of-aion_timeline`（实体时间轴）：按实体（可选限定属性）
  查询属性变更史，当前值在前、历史在后，闭环失败等脏状态如实展示
- 记忆图谱窗口改版：珍珠白樱粉主题贴合昔涟视觉，新增「实体时间轴」区块
  （当前值高亮 + 历史起止日期的轨道图，数据来自 get-state 新增的 claims 字段），
  最近记忆列表配幽灵式遗忘按钮
- 测试 26 → 41 用例：新增 `tests/extractor.test.ts`（6），store/pipeline/tools
  分别 +4/+2/+3，契约测试同步 4 工具

### 兼容性

- `MemoryRecord.entityClaims` 自 v0.1.0 预留后正式启用；旧库数据无需迁移，
  无 claims 的记录行为完全不变
- 插件 id 由 `suiyue-lianyi` 更名为 `ripples-of-aion`（发布前窗口期，无外部用户）：宿主会按新 id 重建插件数据目录，老用户需将 `plugin-data/suiyue-lianyi/` 手工改名为 `plugin-data/ripples-of-aion/` 以保留记忆，并在插件面板重新启用

## [0.1.0] - 2026-09-07

### 新增

- 骨架 + 最小纵切闭环：`host:turn:finished` → 串行队列 → 冻结边界分页读消息 →
  LLM 抽取事实 → 可选向量化 → 逐事实 `remember()` 收口写入
- 内容哈希去重：完全相同的事实全局只存一份，turnEventId 保留溯源，
  轮次摄入标记 `hasTurnEvent` 永久保留
- JSONL 追加日志 + 内存索引存储（put/del op 重放，坏行跳过，不依赖 native sqlite）
- 混合检索：关键词召回打底 + 可用向量重排（向量 1.0 > 关键词 0.7），
  未配置 embedding 时自动降级纯关键词
- OpenAI 兼容 embedding 工厂（地址可配，密钥走 `ctx.deps.secrets`，无 key 降级）
- rerank 接口与直通实现（预留 LLM 精排接入点）
- 三个 AI 工具：`suiyue-lianyi_recall` / `suiyue-lianyi_search` / `suiyue-lianyi_forget`
- hot-context prompt provider：注入 top-3 相关事实，预算自检（默认 900 字符）
- 记忆图谱窗口骨架 + 私有 IPC（`get-state` / `forget`，走 `ctx.registerIpc`）
- 全量测试 26 用例（vitest）：store 7 / queue 5 / pipeline 5 / tools 6 / contract 3，
  契约测试直接加载构建产物，覆盖率上传 Codecov
- CI：Node 22/24 矩阵全链路（typecheck → build → test → check-sync），覆盖率上传
  Codecov；tag 推送自动跑质量链、校验标签与 manifest/package 版本一致、打插件 ZIP
  并创建 GitHub Release；CodeQL（security-extended）每周扫描 + PR 检查；CodeRabbit
  按 .coderabbit.yaml 的项目硬规则做 PR 逐行评审；
  Dependabot 每周跟进开发依赖与 Actions 版本
- 构建链：esbuild 单文件打包 + `check-sync` prepack 闸门（双向验证）+ 本机一键部署

### 已知未实现（规划中）

- 实体抽取 + `valid_until` 属性时间轴（`MemoryRecord.entityClaims` 字段已预留）
- heat 热度衰减、autoDream 空闲整合、LLM rerank 精排
