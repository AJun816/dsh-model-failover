# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow semver.

## [glm-suite 0.2.1] — 2026-11-01（联网校验修复）

### Fixed
- 配置端点字段（searchMcpURL/readerMcpURL/zreadMcpURL）此前未接进 MCP 客户端（死配置）——端点变化现在自动重建客户端（会话缓存随之更换）。
- 本地 http 兜底对二进制内容（PDF/图片等）不再文本解码，显式报 unsupported（对齐官方 http provider 语义），避免向模型返回乱码。
- 移除遗留死代码（SETTINGS_NAMESPACE）。

### 调研结论（2026-11-01 联网校验）
- 社区同类插件（zhipu_plan_tools / dsh-web-search-zai）无公开 issue；官方使用须知并发/风控条款复核无新增约束。
- 重复 bundle 行为经 app-boot composeEntries 实证：同名 insert 不合并、产生双行双加载——README 明确「只保留 root bundle，勿单独再挂 dsh-glm-suite」。

## [0.9.3] — 2026-11-01

### Changed — 配置链是权威边界（语义修正）
- **`fallbackToCatalog` 默认值 true → false**。事故复盘（21:55）：deepseek 配额耗尽后，旧默认把请求兜底进用户从未配置的 workbuddy-* 渠道，撞上服务端 11128 渠道封禁。新语义：**不显式 opt-in，请求绝不离开配置的链**；需要跨组兜底的用户在配置里写 `fallbackToCatalog: true`（配合 `catalogExclude` 排除死渠道）。
- 新增事故回归测试：默认关闭时组内全冷却 → 原样透传，绝不去组外 provider。

### Changed — 代码整洁之道重构（行为保持）
- 717 行单文件拆为七模块：`types.ts`（契约）/ `coerce.ts`（配置读取）/ `classifier.ts`（失败分类）/ `pool.ts`（冷却池）/ `records.ts`（切换记录三通道）/ `config.ts`（schema+分组）/ `index.ts`（瀑布装配）。
- 提取小函数：`agentKeyOf`/`createBudgets`/`createFlightTracker`/`startAutoDiscovery`/`reroute`；魔数集中为命名常量（REVIVE_INTERVAL_MS/IN_FLIGHT_CAP/BUDGET_CAP/FALLBACK_HOPS_PER_STEP）。
- 守卫测试升级为扫描全部编译产物（模块拆分后记录代码在 lib/records.js）。
- 预算消耗时序、冷却 extend-only、revive 语义与原实现逐字对齐（重构期间发现并纠正了两处凭记忆造成的偏差）。

## [0.9.2] — 2026-11-01

### Added — 渠道封禁防线（WorkBuddy 11128 事故）
- `catalogExclude` 配置：按精确 id 或 `前缀*` 通配把 provider 从自动链与目录兜底中排除——协议级被封的逆向渠道（如 dsh-workmate 的 workbuddy-*，服务端 11128 "Illegal API invocation from an unapproved channel"）不再被兜底选中。
- 分类器：`unapproved channel` / `illegal api invocation` 消息归为 `auth` 类——渠道被封的 provider 会进入冷却并被跳过，而不是归为 other 每轮重撞。
- 测试 +2（含真实 11128 报错串分类、排除匹配边界），30/30。

## [0.9.1] — 2026-11-01

### Changed — 拆分：dsh-glm-suite 独立成仓
- 0.9.0 的"一仓双插件"形态按维护性拆分：GLM 套餐插件移至独立仓库 [AJun816/dsh-glm-suite](https://github.com/AJun816/dsh-glm-suite)（v0.3.0 起独立演进）。
- 本仓库回退为纯 model-failover：root 依赖、根 patch 的 glm-suite 行与 web 钉选、README 双插件章节、packages/ 目录全部移除。
- 安装本仓库不再接管 web_search/web_fetch；需要 GLM 套餐请单独安装 dsh-glm-suite。

## [0.9.0] — 2026-11-01

### Added — 一仓双插件：dsh-glm-suite（GLM Coding Plan 四件套）
- `packages/glm-suite`：GLM Coding Plan 套餐能力的完整封装，root `file:` 依赖随本包安装，根 patch 插入 `glm-suite` 行并把 `web` 行钉到智谱 —— **一次安装两个插件同时生效**。
  - 搜索：`web_search` 后端 → `web_search_prime` 套餐 MCP（provider `zhipu-official`）
  - 读取：`web_fetch` 后端 → `webReader` 套餐 MCP（provider `zhipu-reader`），池耗尽本地 http 兜底
  - 仓库：`glm_zread_search_doc / glm_zread_repo_structure / glm_zread_read_file` 原生工具（zread MCP）
  - 视觉：`glm_vision_*` 八件原生工具（本地 stdio `@z_ai/mcp-server` 懒启动桥接）
  - **多 key 池轮换**：1310/1308 等窗口错误解析重置时刻自动冷却换号；1113/1309/1313/1000-1003 永久标记；搜索池耗尽显式失败，绝不回落 DeepSeek 计费
  - 质量与实测：9 项单测 + apply 级 10 断言集成测试 + 真 key 冒烟（含 1310 自动轮换、本地图 12s 识图）；调研记录见 `research/glm-mcp-for-dsh.md`
- 根 patch 新增 `web` 行钉选；不想要 GLM 网络接管的用户可在用户层 patch 关闭（README「退出 GLM 接管」）。

## [0.8.4] — 2026-10-31

### Added
- Regression-guard test: compiled output must contain zero direct required-event append calls; session records only via `appendPluginRecord` with the `plugin:` grammar.
- `scripts/repair-session-log.py`: scan + frame-faithful repair of session logs damaged by pre-0.8.1 versions (`--dry-run` to scan; backups to `~/.dsh/session-repair-backups/`).

## [0.8.3] — 2026-10-31

### Fixed — session-safety hardening
- Recording is fully fire-and-forget-safe (`.catch` on the note path): a switch can never become an unhandled host rejection.
- Plugin-record writer lookup caches success but retries after failure (a transient import failure no longer kills the channel until restart).
- A non-object downstream config passes through untouched instead of throwing inside `reroute()`.
- New regression tests: all-channels-fail switch; garbage-payload waterfalls.

## [0.8.2] — 2026-10-31

### Fixed — pre-publish audit (dedicated audit agent against DSH plugin standards)
- Dropped the machine-specific absolute switch-log default; the log now derives from `import.meta.url` next to `lib/` (works for git/npm/local installs and every user).
- `agent/request` routing failures now degrade to the resolved config instead of rethrowing; downstream errors still propagate unchanged.
- `agent/request-error` catch can no longer run `next()` twice (no duplicate llm-retry recovery).
- `ModelCatalog` interface gains `routableProviders` (matches the wire schema).
- Auto-chain preview now matches actual routing (registration order) instead of claiming default-model-first.
- Bounded the `inFlight` map; README test counts and local-path example fixed; compatibility notes added.

## [0.8.1] — 2026-10-31

### Fixed
- Session records moved to the official `appendPluginRecord` channel with type `plugin:model-failover/switch` (grammar-validated, envelope-marked `ignorable: true`). Previously the plain required-event append channel wrote an unknown event type, which the DSH persistence reader refuses to load ("unknown to this harness and not marked ignorable"), breaking history load for affected sessions.

## [0.8.0] — 2026-10-31

### Added
- Switch notices through three official channels: a session transcript event, a plugin JSONL switch log, and the `lastSwitches` advisory field rendered as a GUI banner.

## [0.7.0] — 2026-10-31

### Added / Changed
- Prepended `agent/request` listener (Default-model override fix), volatile-safe config reads, instant failover without llm-retry delay, catalog fallback, second-chance recharge probe.

## [0.5.0] — 2026-10-30

### Added
- Auto-discovery of configured providers as the default chain; native-style card redesign.

## [0.4.0] — 2026-10-30

### Added
- ui-primitives styling, model-catalog picker, duplicate-account helper.

## [0.3.0] – [0.3.4] — 2026-10-30

### Added
- Plugins-page GUI card editing fallback config over generic settings RPC; bundle patch declaration; client externals and module-loader fixes; volatile Config fields so the namespace is served with live effect-wired listeners.

## [0.1.0] – [0.2.x] — 2026-10-29

### Added
- M1: dual-waterfall failover, failure classifier, cooldown pool, retry budget, Retry-After support, llm-retry composition, neutral-field whitelist, TypeScript migration with committed `lib/`, 18 tests, CI.

[Unreleased]: https://github.com/AJun816/dsh-model-failover/compare/v0.8.4...HEAD
[0.8.4]: https://github.com/AJun816/dsh-model-failover/compare/v0.8.3...v0.8.4
[0.8.3]: https://github.com/AJun816/dsh-model-failover/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/AJun816/dsh-model-failover/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/AJun816/dsh-model-failover/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/AJun816/dsh-model-failover/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/AJun816/dsh-model-failover/compare/v0.5.0...v0.7.0
