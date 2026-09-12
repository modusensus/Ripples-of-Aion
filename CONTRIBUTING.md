# Contributing

> **English** | [中文](#贡献指南)

---

## Prerequisites

- **Node.js 22+** (CI runs on Node 22 and 24)
- **npm** (the repo uses npm; CI installs with `npm ci`)
- **git** (the repo is LF-normalized via `.gitattributes`; git converts automatically)

---

## Repository Layout

```
ripples-of-aion/
├── manifest.json         # Cyrene plugin manifest (apiVersion / id / deps)
├── README.md / CHANGELOG.md / SECURITY.md
├── src/                  # TypeScript source — all feature work happens here
│   ├── core/             # memory model, JSONL store, remember() write gate
│   ├── pipeline/         # task queue, turn ingest, LLM extraction, embedder factory
│   ├── retrieval/        # hybrid search, rerank
│   ├── tools/            # ripples-of-aion_recall / search / timeline / forget
│   ├── provider/         # hot-context prompt provider
│   ├── ui/               # graph window, private IPC, panel
│   └── index.ts          # register / unregister / open
├── tests/                # vitest suite (11 suites / 112 cases)
├── scripts/              # build.mjs / check-sync.mjs / deploy.mjs
└── dist/                 # build output (gitignored, never hand-edited)
```

**Key convention: `src/` is the single source of truth; `dist/` is build output.**

- Write code only in `src/`, then run `npm run build` to produce `dist/plugin/ripples-of-aion/`.
- **Never edit `dist/` by hand** — the next build overwrites it.
- `scripts/check-sync.mjs` records a source hash at build time and re-verifies it on `prepack`. If `src/` or `manifest.json` changed without a rebuild, packaging **fails with exit 1**. This exists because a stale compiled artifact is a silent-failure class we have been burned by before.
- Cyrene-Plugins indexes the **compiled `index.cjs`**: before submitting upstream, always `npm run build && npm run check-sync`.

---

## Local Development

```bash
npm ci

npm run typecheck   # tsc --noEmit
npm run build       # esbuild bundle + record source hash (contract tests need this first)
npm test            # vitest full suite
npm run deploy      # build + install into local Cyrene (%APPDATA%/live2d-cyrene/plugins/)
```

> Note the order: **build before test**. The contract suite loads `dist/plugin/ripples-of-aion/index.cjs` directly — it tests exactly what ships, which is why CI also builds first.

| Command | Description |
|---------|-------------|
| `npm run typecheck` | TypeScript strict check, no emit |
| `npm test` | Full vitest suite (store / queue / pipeline / contract) |
| `npm run test:coverage` | Tests + v8 coverage (uploaded to Codecov in CI) |
| `npm run build` | esbuild bundle + manifest + panel assets |
| `npm run check-sync` | Verify source hash ↔ artifact consistency |
| `npm run deploy` | Build and copy into local Cyrene plugin dir |

---

## Testing Conventions

- Tests use **vitest**; test files live in `tests/`, named `*.test.ts`, shared helpers in `tests/helpers.ts`.
- New features require corresponding tests; changing core logic (dedup keys, queue semantics, retrieval fusion) must update the affected assertions so the suite stays green.
- The contract suite (`tests/contract.test.ts`) asserts the **built artifact**: tool id prefixes, provider, IPC channels, subscriptions, and idempotent unregister. If you change `src/index.ts`, rebuild before running tests.
- When the number of test cases changes, update the `tests` badge in `README.md` (both language sections).

---

## Code Style & Engineering Conventions

- **TypeScript strict mode**; the artifact is CommonJS (`index.cjs`), bundled by esbuild. Keep `electron` lazy-required inside `ui/` so tests never need it.
- **Comments in Chinese**, biased toward "why" — fail-safe branches, dedup keys, queue semantics must explain their intent.
- **Fail-safe is a hard rule**: local failures in any background path (extraction, embedding, storage) must skip or degrade, **never** block the chat flow.
- **All memory writes go through the single gate `core/remember.ts`** — do not bypass it; dedup lives there.
- Background work runs in the **serial `TaskQueue`** and must respect `ctx.signal`. `host:turn:finished` is a bypass notification: the listener only enqueues.
- Zero runtime dependencies by design: Node builtins + global `fetch` + host-provided services only. Adding a runtime dependency requires strong justification.
- Errors from host services branch on **stable error codes** (`isPluginHostError` + `E_*`), never on message text.

---

## Commits & Branches

- Commit messages follow **Conventional Commits**:

  ```
  feat(timeline): entity attribute timeline with valid_until
  fix(store): tolerate half-written JSONL lines after crash
  docs: expand bilingual README
  ```

- Run `npm run typecheck && npm test` (after `npm run build`) and confirm green before committing.
- **Small fixes**: can push straight to `main` (this is the project's workflow).
- **Larger features / breaking changes**: open an Issue first to state motivation and design, then submit a PR — PRs trigger CI (Node 22 + 24 matrix, full quality chain).
- **Commit identity**: each contributor commits under their own identity. Commits must not carry tool or AI attribution (no `Co-Authored-By` footers naming tools/AI).

---

## Scope: Platform Adaptation & Wrapper PRs

Cyrene's plugin API is v1 and still evolving. PRs that adapt this plugin to other hosts or wrap it into other plugin ecosystems are **not a priority** and are reviewed with extra caution — they tend to bind against unstable upstream APIs, and the maintenance burden falls back on this project. The currently supported platform is **Cyrene**.

Exceptions: if a contributor is willing to **own long-term maintenance** (track upstream changes and fix breakage), open an Issue first to scope the work.

---

## Release Process (Maintainers)

Versioning follows SemVer (`MAJOR.MINOR.PATCH`). `manifest.json` and `package.json` versions are bumped **together** (they must match):

1. **Update CHANGELOG.md**: add a version entry at the top.
2. **Bump version** in both `manifest.json` and `package.json` (and `package-lock.json` via `npm install`).
3. **Full quality chain green**: `npm run typecheck && npm run build && npm test && npm run check-sync`.
4. **Commit and push** → `git tag vX.Y.Z` → `git push origin vX.Y.Z` → the Release workflow packages the ZIP and creates the GitHub Release.
5. **Edit the Release notes to the fixed format** (see below); release bodies stay short — details live in CHANGELOG.
6. **Submit to Cyrene-Plugins** (when ready): PR with `manifest.json` + compiled `index.cjs` (+ panel assets); the upstream maintainers package the ZIP. `prepack` runs the check-sync gate automatically.
   **Temporary (2026-09)**: the upstream Cyrene-Plugins repo on GitHub is temporarily unreachable (maintainer account suspended, appeal in progress) — until it returns, submit inclusion PRs to the [Gitee mirror](https://gitee.com/playa0/cyrene-plugins) or contact the maintainer directly (see [Ripples-of-Aion#13](https://github.com/modusensus/Ripples-of-Aion/issues/13)).

**Fixed release-notes format** (title `岁月涟漪 · Ripples of Aion vX.Y.Z`):

```markdown
## ✨ 新增
- <要点，每条一行>

## 🔧 修复
- <要点，每条一行>

## 📦 安装

下载下方 `ripples-of-aion-vX.Y.Z.zip`，在 Cyrene 插件面板「导入插件」后手动启用。

> <可选：升级/迁移提示。>
> 完整变更见 [CHANGELOG](https://github.com/modusensus/Ripples-of-Aion/blob/main/CHANGELOG.md)。
```

---

## Contact

- **General questions & contributions**: open an Issue / Discussion, or email `work@modusensus.space`
- **Security vulnerabilities**: report privately via [SECURITY.md](SECURITY.md) — never open a public issue for vulnerabilities

---

# 贡献指南

> **中文** | [English](#contributing)

---

## 环境要求

- **Node.js 22+**（CI 在 Node 22 和 24 上跑矩阵）
- **npm**（仓库使用 npm，CI 用 `npm ci`）
- **git**（仓库通过 `.gitattributes` 统一为 LF，git 会自动转换）

---

## 代码库布局

```
ripples-of-aion/
├── manifest.json         # Cyrene 插件清单（apiVersion / id / deps）
├── README.md / CHANGELOG.md / SECURITY.md
├── src/                  # TypeScript 源码，所有功能都在这里开发
│   ├── core/             # 记忆模型、JSONL 存储、remember() 写入收口
│   ├── pipeline/         # 任务队列、turn 摄入、LLM 抽取、embedding 工厂
│   ├── retrieval/        # 混合检索、rerank
│   ├── tools/            # ripples-of-aion_recall / search / timeline / forget
│   ├── provider/         # hot-context prompt provider
│   ├── ui/               # 图谱窗口、私有 IPC、面板
│   └── index.ts          # register / unregister / open
├── tests/                # vitest 测试（11 套件 / 112 用例）
├── scripts/              # build.mjs / check-sync.mjs / deploy.mjs
└── dist/                 # 构建产物（gitignore，禁止手改）
```

**关键约定：`src/` 是唯一的事实来源，`dist/` 是构建产物。**

- 所有代码改动只写 `src/`，改完运行 `npm run build` 生成 `dist/plugin/ripples-of-aion/`。
- **不要手工编辑 `dist/`**——下次构建会覆盖你的改动。
- `scripts/check-sync.mjs` 在构建时记录源码哈希，`prepack` 时重新校验。`src/` 或 `manifest.json` 变了而产物没重建，打包会**直接 exit 1 失败**——这个闸门存在的原因是「产物静默失效」是我们真实踩过的坑。
- Cyrene-Plugins 收录的是**编译产物 `index.cjs`**：向上游提交前务必 `npm run build && npm run check-sync`。

---

## 本地开发

```bash
npm ci

npm run typecheck   # tsc --noEmit
npm run build       # esbuild 打包 + 记录源码哈希（契约测试依赖这一步）
npm test            # vitest 全量测试
npm run deploy      # 构建 + 安装到本机 Cyrene（%APPDATA%/live2d-cyrene/plugins/）
```

> 注意顺序：**先 build 再 test**。契约测试直接加载 `dist/plugin/ripples-of-aion/index.cjs`——测的就是要发布的东西，所以 CI 也是先构建再测试。

| 命令 | 说明 |
|------|------|
| `npm run typecheck` | TypeScript 严格模式检查 |
| `npm test` | vitest 全量测试（store / queue / pipeline / contract） |
| `npm run test:coverage` | 测试 + v8 覆盖率（CI 中上传 Codecov） |
| `npm run build` | esbuild 打包 + manifest + 面板资源 |
| `npm run check-sync` | 校验源码哈希 ↔ 产物一致性 |
| `npm run deploy` | 构建并拷贝到本机 Cyrene 插件目录 |

---

## 测试约定

- 测试框架为 **vitest**；测试文件放 `tests/`，命名 `*.test.ts`，共享 helper 在 `tests/helpers.ts`。
- 新增功能必须有对应测试；修改核心逻辑（去重键、队列语义、检索融合）时必须同步更新受影响用例的断言，保证全量测试通过。
- 契约测试（`tests/contract.test.ts`）断言的是**构建产物**：工具 id 前缀、provider、IPC 通道、事件订阅、unregister 幂等。改了 `src/index.ts` 记得先重建再跑测试。
- 测试用例数量变化时，记得同步更新 `README.md` 顶部（两段语言里）的 tests 徽章。

---

## 代码风格与工程约定

- **TypeScript 严格模式**；产物为 CommonJS（`index.cjs`），esbuild 打包。保持 `electron` 在 `ui/` 内懒加载 require，测试环境不依赖它。
- **注释用中文**，偏向「解释为什么」——fail-safe 分支、去重键、队列语义都要求写清意图。
- **fail-safe 是硬性约定**：所有后台链路（抽取、向量化、存储）的局部失败只能跳过或降级，**绝不能**阻断聊天主流程。
- **所有记忆写入必须走唯一收口 `core/remember.ts`**——不要绕过它，去重逻辑在那里。
- 后台工作一律进**串行 `TaskQueue`** 并尊重 `ctx.signal`。`host:turn:finished` 是旁路通知：监听器里只投队列。
- 设计上**零运行时依赖**：只用 Node 内置模块 + 全局 `fetch` + 宿主注入的服务。引入运行时依赖需要充分理由。
- 宿主服务的错误只按**稳定错误码**分支（`isPluginHostError` + `E_*`），绝不匹配错误文案。

---

## 提交与分支

- 提交信息遵循 **Conventional Commits**：

  ```
  feat(timeline): 实体属性时间轴 valid_until
  fix(store): 崩溃后半行 JSONL 容错
  docs: 补充双语 README
  ```

- 提交前跑 `npm run typecheck && npm test`（先 `npm run build`），确认全绿。
- **小改动 / 修复**：可直推 `main`（本项目采用此工作流）。
- **较大功能 / 破坏性改动**：先开 Issue 说明动机与方案，再通过 PR 提交，PR 会触发 CI 校验（Node 22 + 24 矩阵 + 全量质量链）。
- **提交身份**：每位贡献者以本人身份提交。提交不得携带任何工具或 AI 署名（禁止 `Co-Authored-By` 尾注标注工具/AI）。

---

## 范围：平台适配与封装 PR

Cyrene 插件 API 还是 v1，仍在演进。把本插件适配到其他宿主、或封装进其他插件体系的 PR **不作为优先项**，且会以额外谨慎的态度审查——这类 PR 往往绑定不稳定的上游接口，维护责任会落到本项目头上。当前唯一受支持的平台是 **Cyrene**。

例外：如果贡献者愿意**承担长期维护**（跟进上游变更并修复 break），请先开 Issue 沟通范围。

---

## 发布流程（维护者）

版本号遵循语义化版本（`MAJOR.MINOR.PATCH`）。`manifest.json` 和 `package.json` 的版本号**一起改**（必须一致）：

1. **更新 CHANGELOG.md**：在顶部新增版本条目。
2. **改版本号**：`manifest.json` 与 `package.json`（`package-lock.json` 经 `npm install` 同步）。
3. **全量质量链绿**：`npm run typecheck && npm run build && npm test && npm run check-sync`。
4. **提交推送** → `git tag vX.Y.Z` → `git push origin vX.Y.Z` → Release 工作流会打包 ZIP 并创建 GitHub Release。
5. **按固定格式改写 Release 说明**（见下）；Release 说明保持简短，细节留在 CHANGELOG。
6. **提交 Cyrene-Plugins 收录**（就绪后）：PR 提交 `manifest.json` + 编译产物 `index.cjs`（+ panel 资源）；ZIP 由上游维护者统一打包。`prepack` 会自动跑 check-sync 闸门。
   **临时备注（2026-09）**：GitHub 上的 Cyrene-Plugins 上游仓库暂时无法访问（维护者账号被封禁、申诉中）——恢复前收录 PR 提交到 [Gitee 镜像](https://gitee.com/playa0/cyrene-plugins)，或直接联系维护者（见 [Ripples-of-Aion#13](https://github.com/modusensus/Ripples-of-Aion/issues/13)）。

**Release 说明固定格式**（标题 `岁月涟漪 · Ripples of Aion vX.Y.Z`）：

```markdown
## ✨ 新增
- <要点，每条一行>

## 🔧 修复
- <要点，每条一行>

## 📦 安装

下载下方 `ripples-of-aion-vX.Y.Z.zip`，在 Cyrene 插件面板「导入插件」后手动启用。

> <可选：升级/迁移提示。>
> 完整变更见 [CHANGELOG](https://github.com/modusensus/Ripples-of-Aion/blob/main/CHANGELOG.md)。
```

---

## 联系方式

- **一般问题与贡献咨询**：开 Issue / Discussion，或邮件 `work@modusensus.space`
- **安全漏洞**：请通过 [SECURITY.md](SECURITY.md) 私有提交，不要在公开 Issue 中提交漏洞

---
