# Security Policy

> **English** | [中文](#安全策略)

---

## Trust Boundary (Read This First)

Cyrene plugins run inside the **Electron main process with full Node.js permissions** — they are **not sandboxed**, not web extensions, and not permission-isolated. This is the host's documented trust model: only install plugins whose source you can review and trust.

Within that model, this plugin is designed to minimize its own exposure:

- It only requests `llm`, `conversations`, and `secrets` capabilities from the host.
- It performs **no filesystem access outside its own plugin-data directory**.
- It **never writes to or reads the built-in memory engine** — it is a fully parallel layer.
- With default configuration it makes **zero network requests**.

---

## Supported Versions

| Version | Supported | Status |
|---|---|---|
| 0.1.x | ✅ Yes | Active development |
| < 0.1.0 | — | No earlier releases exist |

---

## Known Security Features

Implemented and maintained as of 0.1.0:

| Feature | Description | Status |
|---|---|---|
| Zero runtime dependencies | The bundle uses only Node builtins, global `fetch`, and host-injected services — no third-party runtime supply chain | ✅ Implemented |
| Local-first by default | `embeddingProvider: "none"` (default) means every code path is offline; no telemetry, no analytics, no remote logging anywhere | ✅ Implemented |
| Disclosed opt-in network surface | Enabling `openai-compatible` embeddings sends **fact texts and query text** to the endpoint *you* configure. This is the plugin's only outbound channel. Point it at a local endpoint to stay fully offline | ✅ Documented |
| Secrets via host secure store | The embedding API key lives in the host secure store (`ctx.deps.secrets`); it is never hardcoded, never written to plugin storage, never logged | ✅ Implemented |
| Append-only journal storage | `memories.jsonl` is append-only; a crash loses at most the last line, malformed lines are skipped with a warning instead of corrupting the store | ✅ Implemented |
| Replay-resistant writes | All writes pass one gate (`remember()`) keyed by content hash — duplicate event delivery cannot produce duplicate memories | ✅ Implemented |
| Fail-safe degradation | Extraction / embedding / storage failures warn and degrade; they can never crash the host or block the chat flow | ✅ Implemented |
| Namespaced IPC only | Panel channels register via `ctx.registerIpc` (host-namespaced `plugin:<id>:<channel>`); no raw `ipcMain` channels are opened | ✅ Implemented |
| XSS-resistant panel | The panel renders memory content via `textContent` only — LLM-derived text is treated as untrusted data, never as HTML | ✅ Implemented |
| Tool id namespacing | All AI tools carry the mandatory `<plugin-id>_` prefix; host enforces rejection of foreign ids | ✅ Implemented |
| Stable error codes | Host service errors branch on `isPluginHostError` + `E_*` codes only — never on message text | ✅ Implemented |
| Supply-chain sync gate | `check-sync` (bound to `prepack`) fails packaging when `src/`/`manifest.json` drift from the built artifact — prevents shipping stale code | ✅ Implemented |
| CI quality gate | Every push/PR runs the full chain (typecheck → build → tests → check-sync) on Node 22 and 24 | ✅ Implemented |
| Committed lockfile | `package-lock.json` is committed; CI installs with `npm ci` (reproducible installs) | ✅ Implemented |

---

## Prompt-Injection Note (LLM-Derived Content)

Memory records are **LLM-derived** and later re-injected into prompts and rendered in the panel. This plugin treats them strictly as data:

- Panel rendering uses `textContent` (no HTML interpretation).
- Injected context blocks contain short factual lines with a fixed header and a self-checked character budget.
- Anyone extending this plugin must keep treating memory content as untrusted input: never interpolate it into HTML, shell commands, or file paths.

---

## Reporting a Vulnerability

### Please DO NOT

- Open a public issue for security vulnerabilities
- Post exploit details in discussions or comments
- Submit PRs that expose security flaws without prior coordination

### Please DO

1. **Email** `work@modusensus.space` (or open a **private security advisory** via [GitHub Security Advisories](https://github.com/modusensus/suiyue-lianyi/security/advisories))
2. Include:
   - A clear description of the vulnerability
   - Steps to reproduce (minimal test case preferred)
   - Impact assessment (data exposure? local-only? cross-plugin?)
   - Affected versions
   - Your proposed fix (if any)
   - Whether you are requesting credit / disclosure preferences

### Scope and Out of Scope

**In scope** — issues this policy covers:
- Leakage of secrets or memory content beyond the surfaces documented above
- Silent data corruption or loss in the JSONL store (including dedup-bypass paths)
- Prompt-injection escalation: LLM-derived content reaching HTML/shell/path contexts
- Check-sync gate bypasses that could ship a stale artifact
- Exploitable vulnerabilities in shipped runtime dependencies (currently: none — zero runtime deps)

**Out of scope** — we will not act on:
- The Cyrene host itself (plugin loader, ZIP import validation, sandboxing) — report upstream to Cyrene
- Social engineering or phishing against maintainers or users
- DoS claims that require unrealistic local resource exhaustion with no product defect
- Best-practice hardening suggestions with no demonstrable security impact

Not sure whether your finding is in scope? Report it anyway via the private channel — we will triage and respond.

### Response Timeline

| Phase | Time | Action |
|---|---|---|
| Acknowledgment | Within 48 hours | We confirm receipt and assign a tracking ID |
| Initial Assessment | Within 7 days | We validate severity and scope; we may request additional information |
| Fix Development | Severity-dependent | Critical: ≤ 14 days; High: ≤ 30 days; Medium/Low: next release |
| Validation & Testing | 1–3 days after fix | We run regression and security tests on the patch |
| Coordinated Disclosure | At fix release | We publish a security advisory and release patch simultaneously |

### Severity Classification

We follow the [CVSS v3.1](https://www.first.org/cvss/v3.1/specification-document) standard:

- **Critical** (9.0–10.0): Secret exfiltration, cross-plugin data access, arbitrary code execution paths
- **High** (7.0–8.9): Silent memory corruption, dedup/injection-guard bypass, prompt-injection escalation
- **Medium** (4.0–6.9): Information disclosure under specific conditions, partial control bypass
- **Low** (0.1–3.9): Minor information leakage, defense-in-depth improvements

---

## Security Design Principles

### 1. Local-First, Minimal Surface

- Default configuration is fully offline; no telemetry, no analytics, no remote logging
- The single outbound channel (embeddings) is opt-in, user-configured, and disclosed above
- Zero runtime dependencies — nothing extra to audit, nothing extra to exploit

### 2. Fail-Safe by Default

- Any component failure (LLM, embedder, storage) degrades gracefully — the chat flow is never blocked
- Malformed input (bad JSONL lines, unparseable LLM output) is skipped with a warning, never fatal

### 3. Data Stays Human-Readable

- All memories live in one append-only JSONL file in the plugin-data directory
- Users can inspect, back up, edit, or delete it directly; uninstalling the plugin keeps the data
- `put`/`del` operations replay deterministically to rebuild in-memory indexes

### 4. Respect the Host Contract

- IPC only through host-namespaced registration; no raw Electron channels
- Tool capabilities declared honestly (`read` vs `mutation`); forgetting is `mutation`
- Secrets only through the host secure store — never in config files, storage, or logs

---

## Contributor Security Guidelines

All contributors must comply with the following security requirements:

1. **Dependency audit**: run `npm audit` before submitting a PR; new **runtime** dependencies require strong justification and review
2. **Secret scanning**: never commit API keys, tokens, or credentials
3. **Untrusted data discipline**: memory content and LLM output are data — validate and escape before any new surface (HTML, paths, commands)
4. **Panel rendering**: keep `textContent`-only rendering; introducing `innerHTML` is a security regression
5. **Responsible disclosure**: vulnerabilities found during development must be reported via the private channel, not in public PRs

---

## Contact

- **Security contact**: `work@modusensus.space`
- **Private advisory**: [GitHub Security Advisories](https://github.com/modusensus/suiyue-lianyi/security/advisories)

---

## License

This project is licensed under the **MIT License**. See [LICENSE](LICENSE) for details.

---

# 安全策略

> **中文** | [English](#security-policy)

---

## 信任边界（先读这段）

Cyrene 插件运行在 **Electron 主进程中，拥有完整 Node.js 权限**——**不是沙箱**、不是 Web 扩展、没有权限隔离。这是宿主官方文档写明的信任模型：只安装你能审查且信任其来源的插件。

在这个模型下，本插件的设计目标是把自身暴露面压到最小：

- 只向宿主申请 `llm`、`conversations`、`secrets` 三项能力。
- **不访问自身插件数据目录之外的任何文件**。
- **不读写内置记忆引擎**——它是完全并行的记忆层。
- 默认配置下**发起零网络请求**。

---

## 支持版本

| 版本 | 支持状态 | 说明 |
|---|---|---|
| 0.1.x | ✅ 支持 | 活跃开发中 |
| < 0.1.0 | — | 无更早版本 |

---

## 已知安全特性

截至 0.1.0 已实现并维护：

| 特性 | 描述 | 状态 |
|---|---|---|
| 零运行时依赖 | 产物只用 Node 内置模块、全局 `fetch` 和宿主注入的服务——没有第三方运行时供应链 | ✅ 已实现 |
| 默认本地优先 | `embeddingProvider: "none"`（默认）意味着所有代码路径离线；任何地方都无遥测、无分析、无远程日志 | ✅ 已实现 |
| 明示的 opt-in 网络面 | 启用 `openai-compatible` embeddings 后，**事实文本与查询文本**会发送到*你自己*配置的端点。这是本插件唯一的出站通道；指向本地端点即可完全离线 | ✅ 已明示 |
| 密钥走宿主安全存储 | embedding API key 存在宿主安全存储（`ctx.deps.secrets`）；绝不硬编码、绝不写入插件存储、绝不进日志 | ✅ 已实现 |
| 追加日志式存储 | `memories.jsonl` 只追加；崩溃最多丢最后一行，坏行 warn 跳过而非损坏整库 | ✅ 已实现 |
| 抗重放写入 | 所有写入经过唯一收口 `remember()`（内容哈希键）——事件重复投递不会产生重复记忆 | ✅ 已实现 |
| Fail-safe 降级 | 抽取 / 向量化 / 存储失败只 warn 降级；绝不可能崩溃宿主或阻塞聊天主流程 | ✅ 已实现 |
| 仅命名空间化 IPC | 面板通道通过 `ctx.registerIpc` 注册（宿主命名空间化 `plugin:<id>:<channel>`）；不打开任何裸 `ipcMain` 通道 | ✅ 已实现 |
| 抗 XSS 面板 | 面板只用 `textContent` 渲染记忆内容——LLM 生成的文本按不可信数据处理，绝不按 HTML 解释 | ✅ 已实现 |
| 工具 id 命名空间 | 所有 AI 工具携带强制的 `<插件id>_` 前缀；宿主会拒绝越权 id | ✅ 已实现 |
| 稳定错误码 | 宿主服务错误只按 `isPluginHostError` + `E_*` 码分支——绝不匹配错误文案 | ✅ 已实现 |
| 供应链同步闸门 | `check-sync`（绑定 `prepack`）：`src/`/`manifest.json` 与产物漂移时打包直接失败——杜绝发出过期代码 | ✅ 已实现 |
| CI 质量门 | 每次 push/PR 在 Node 22 与 24 上跑全链路（typecheck → build → 测试 → check-sync） | ✅ 已实现 |
| 锁文件入库 | `package-lock.json` 已提交；CI 用 `npm ci`（可复现安装） | ✅ 已实现 |

---

## 提示词注入说明（LLM 派生内容）

记忆记录由 **LLM 生成**，之后会重新注入提示词、并渲染在面板里。本插件严格把它们当数据处理：

- 面板渲染只用 `textContent`（不做 HTML 解释）。
- 注入的上下文块只含短事实行，带固定标题和自检的字符预算。
- 任何扩展本插件的人都必须继续把记忆内容当不可信输入：绝不把它插值进 HTML、shell 命令或文件路径。

---

## 报告漏洞

### 请不要

- 在公开 issue 中披露安全漏洞
- 在讨论区或评论中发布漏洞利用细节
- 未经事先协调就提交暴露安全缺陷的 PR

### 请这样做

1. **发送邮件**至 `work@modusensus.space`（或通过 [GitHub 私有安全公告](https://github.com/modusensus/suiyue-lianyi/security/advisories) 提交）
2. 邮件内容请包含：
   - 漏洞的清晰描述
   - 复现步骤（优先提供最小测试用例）
   - 影响评估（数据泄露？仅本地？跨插件？）
   - 受影响的版本
   - 你建议的修复方案（如有）
   - 是否要求在公告中署名 / 披露偏好

### 受理范围与不受理范围

**受理范围**——本政策覆盖以下问题：
- 密钥或记忆内容泄露到上述已明示面之外
- JSONL 存储的静默数据损坏或丢失（含去重绕过路径）
- 提示词注入升级：LLM 派生内容进入 HTML / shell / 路径上下文
- 可能导致发出过期产物的 check-sync 闸门绕过
- 已发布运行时依赖中的可利用漏洞（当前：无——零运行时依赖）

**不受理范围**——以下问题我们不予处理：
- Cyrene 宿主本体（插件加载器、ZIP 导入校验、沙箱机制）——请向上游 Cyrene 报告
- 针对维护者或用户的社工 / 钓鱼类问题
- 仅通过不现实的本地资源耗尽触发、且无产品缺陷支撑的 DoS 声明
- 无可证明安全影响的「最佳实践建议」类问题

不确定你的发现是否在受理范围内？仍请通过私有渠道提交——我们会评估并回复。

### 响应时间线

| 阶段 | 时间 | 行动 |
|---|---|---|
| 确认收到 | 48 小时内 | 我们确认收到并分配追踪 ID |
| 初步评估 | 7 天内 | 我们验证严重程度和影响范围；可能需要更多信息 |
| 修复开发 | 按严重程度 | 严重：≤ 14 天；高：≤ 30 天；中/低：下个版本 |
| 验证与测试 | 修复完成后 1–3 天 | 对补丁进行回归测试和安全测试 |
| 协调披露 | 修复发布时 | 同时发布安全公告和补丁版本 |

### 严重程度分级

我们遵循 [CVSS v3.1](https://www.first.org/cvss/v3.1/specification-document) 标准：

- **严重** (9.0–10.0)：密钥外泄、跨插件数据访问、任意代码执行路径
- **高** (7.0–8.9)：静默记忆损坏、去重/注入防护绕过、提示词注入升级
- **中** (4.0–6.9)：特定条件下的信息泄露、部分控制绕过
- **低** (0.1–3.9)：轻微信息泄露、纵深防御改进

---

## 安全设计原则

### 1. 本地优先，最小暴露面

- 默认配置完全离线；无遥测、无分析、无远程日志
- 唯一出站通道（embeddings）为 opt-in、由用户配置、且已在上方明示
- 零运行时依赖——没有多余的东西需要审计，也没有多余的东西可被利用

### 2. 默认 Fail-Safe

- 任何组件故障（LLM、embedder、存储）都优雅降级——聊天主流程绝不被阻塞
- 畸形输入（坏 JSONL 行、无法解析的 LLM 输出）warn 跳过，绝不动致命

### 3. 数据保持人类可读

- 所有记忆都在插件数据目录的同一个追加日志 JSONL 文件里
- 用户可以直接查看、备份、编辑或删除；卸载插件数据仍在
- `put`/`del` 操作确定性重放即可重建内存索引

### 4. 尊重宿主契约

- IPC 只通过宿主命名空间化注册；不开裸 Electron 通道
- 工具能力如实声明（`read` vs `mutation`）；遗忘是 `mutation`
- 密钥只走宿主安全存储——绝不进配置文件、存储或日志

---

## 贡献者安全指南

所有贡献者必须遵守以下安全要求：

1. **依赖审计**：提交 PR 前运行 `npm audit`；新增**运行时**依赖需要充分理由并通过审查
2. **密钥扫描**：禁止向仓库提交 API 密钥、令牌或凭据
3. **不可信数据纪律**：记忆内容和 LLM 输出都是数据——在任何新暴露面（HTML、路径、命令）使用前必须验证和转义
4. **面板渲染**：保持只用 `textContent` 渲染；引入 `innerHTML` 属于安全退化
5. **负责任的披露**：开发过程中发现的安全漏洞必须通过私有渠道报告，而非在公开 PR 中提交

---

## 联系方式

- **安全联系**：`work@modusensus.space`
- **私有公告**：[GitHub Security Advisories](https://github.com/modusensus/suiyue-lianyi/security/advisories)

---

## 许可协议

本项目基于 **MIT License** 开源。详见 [LICENSE](LICENSE)。

---
