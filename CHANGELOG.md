# Changelog

本插件遵循 [SemVer](https://semver.org/lang/zh-CN/)。版本号三段式由 `manifest.json`
与 `package.json` 同步维护——发布前跑 `npm run check-sync` 防止产物静默失效。

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
  并创建 GitHub Release；CodeQL（security-extended）每周扫描 + PR 检查；
  Dependabot 每周跟进开发依赖与 Actions 版本
- 构建链：esbuild 单文件打包 + `check-sync` prepack 闸门（双向验证）+ 本机一键部署

### 已知未实现（规划中）

- 实体抽取 + `valid_until` 属性时间轴（`MemoryRecord.entityClaims` 字段已预留）
- heat 热度衰减、autoDream 空闲整合、LLM rerank 精排
