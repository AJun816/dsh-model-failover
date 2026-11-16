# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow semver.

## [0.9.10] — 2026-11-02

### Fixed — volatile 描述符拆包（"armed 后同毫秒变 inactive"事故根治）
- 机制：settings 层接管配置命名空间后，字段以 cosmokit volatile 描述符（`{ get, [volatile.write] }`）到达；普通读取拿到包装对象，`Array.isArray(groups)` 静默失败 → 空链 inactive。load.log 铁证：`armed: active entries=3` 与 `armed: inactive entries=0` 同一毫秒。
- 修复：所有配置读取统一经 `unwrapVolatile`（描述符调 `get()` 取真值，普通值直通），覆盖 groups/activeGroup/cooldownMinutes/retryOn/autoDiscover/fallbackToCatalog/catalogExclude。
- 回归测试：volatile 包装配置 → armed ACTIVE + 路由正常。

## [0.12.0] — 2026-11-16

### Added — 替补链预检（`probeOnDegraded`）：一次探针替代逐个试错
- 问题：DSH 0.2.2 每步固定路由，同一回合无法换号，于是每个死号都要吃一条用户可见失败；用户提出「先检查哪个替补可用，再顺位切换」。
- 方案（对齐 LiteLLM / OpenRouter / one-api 的通行做法：有序链 + 熔断冷却 + 必要时才探测，健康期不探测）：
  - 仅降级期（有账号冷却或带供应商恢复时间）启用预检，健康期零额外请求；
  - 用 `ctx.llm.stream()` 发 1-token 探针（`maxTokens: 1`、`temperature: 0`），默认 2500ms 超时；DSH 以终止帧 `finish.reason.kind === 'error'|'aborted'` 报错（不抛异常），据此判定不可用；
  - 一轮沿链验证：探针失败即冷却 + 记录供应商恢复时间，继续下一棒，直接落到真正可用的账号（切换记录 `via: 'probe'`，GUI 显示「替补链预检」）；
  - 预检成功缓存 5 分钟；探针不可用（宿主无 `llm.stream`）时行为与此前完全一致；
  - `agent/pre-step` 同样预检：当前选择已不可用时，进入回合前就迁移，不再先失败一次；
  - 验证总预算 6s（`VERIFY_BUDGET_MS`），超时按链序继续，绝不卡回合。
- 诊断脚本新增场景 D：一次失败 + 2 次探针 → 直接落到可用账号；关闭预检则回落链序（对照）。测试 55/55。

## [0.11.8] — 2026-11-16

### Fixed — 冷却/恢复时间持久化 + 已知死号预检跳过（重启后不再逐个撞死号）
- 事故（14:28，用户实测）：14:27 重启后内存池被清空，14:28 撞 zai-1（14:32 恢复）→ 切到 zai-2（11-17 才恢复）→ 用户下一条消息继续失败。日志证明切换本身已经正确（0.11.7），缺的是"新进程不知道哪个号已经到期"。
- 修复：
  1. 冷却与供应商声明的恢复时间持久化到 `$DSH_HOME/model-failover/state.json`（原子写、按进程隔离临时文件、30 天上限、坏文件忽略），重启后自动恢复；
  2. 首次运行从 `switches.log` 播种各账号最近一次声明的恢复时间（最新声明优先；最新声明时间已过 → 视为额度已恢复并清除旧值）；
  3. `agent/pre-step` 增加预检跳过：当前选择被供应商标记为未到期、且链中存在"干净"替补时，下一步直接迁移，不再先烧一条失败消息；
  4. 被标记账号永不从链中移除（额度地板账号仍可服务正常请求）；无干净替补时保持原位。
- `scripts/e2e-diagnose.mjs` 新增场景 C（重启后不重复踩已知死号）并接入退出码；场景 B 保留。50/50 测试。
- 真实 `switches.log` 干跑（14:35）：zai-1 的 14:32 恢复声明生效 → 不再标记；zai-2/zai-3 标记 11-17；下一条消息直接路由回 `zai-coding-cn/glm-5.3`。

## [0.11.7] — 2026-11-16

### Fixed — DSH 0.2.2 固定路由下失败账号归属错误（"额度到期后无法自动切换"事故）
- 事故（用户实测 14:14）：默认模型 `deepseek-account/deepseek-flash` 额度到期后，插件把链首 `zai-coding-cn` 当成失败账号冷却，真正额度到期的 `deepseek-account` 从未被拉黑；手动选择链内第二棒时更糟——冷却了链首、下一步仍选中死号，选择原地不动。
- 根因：`agent/request` 的 0.2.2 固定路由分支记录 in-flight 路由时用了"链首健康条目"而非本步真实固定路由；`agent/request-error` 据此冷却了错误账号，`agent/pre-step` 又认为当前选择健康而不再转移 → 额度到期的账号永远留在选择上。
- 修复：0.2.2 分支按本步真实路由记账（resolved 配置，异常时回退 modelSelection / `agent.model.current()`）；新增防御——绝不把刚失败的同一路由再次选为下一棒。
- 回归：新增 manual-choice（手动选链内第二棒）与 off-chain default（链外 deepseek-account）两条用例；`scripts/e2e-diagnose.mjs` 新增场景 B（B1/B2 自动断言冷却对象与交棒结果）。
- 配置：desktop / web 两个 profile 的替补链尾加入 `deepseek-account/deepseek-flash` 作为兜底。

## [0.11.6] — 2026-11-15

### Fixed — second-chance 探测风暴根治（"一直切换失败"事故）
- 事故（20:26–20:29，用户实锤）：分组仅剩 2 棒且全部真死（zai TIMEOUT + minimax Token Plan 限额），配置 `cooldownMinutes: 3` 使冷却后 `remaining`(3min) 恒小于复活窗口(15min) → 所有冷却账号永远"可复活"；唯一节流是每账号 5 分钟，双账号交替 → 每 2.5 分钟一次必然失败的探测，无任何退避。诊断脚本 `scripts/e2e-diagnose.mjs`（100% 复刻生产配置与故障）实测：90 分钟 36 次用户可见失败。
- 修复（三层）：
  1. **刚失败不探测**：失败时间 < REVIVE_INTERVAL(5min) 的账号不作为复活候选（旧逻辑只节流"上次复活"，失败 6 秒后即可再被复活，双账号交替绕过节流）；
  2. **探测失败指数退避**：复活后 10 分钟内再失败计为一次探测失败，该账号探测间距 ×4（5min→20min→1h20m→5h20m，封顶 6h）；健康服务过则清零；
  3. **activeGroup 漂移告警**：activeGroup 指向不存在的分组 id 时（本次生产实锤 `glm-pool` vs `main`）打 warn 日志，不再静默回退首组。
- 修复后同一场景：90 分钟 0 次探测失败；流量静默 ≥5min 后探测仍可恢复（充值探测语义保留，回归测试覆盖）。42/42。
- 附带修复生产配置（~/.dsh/profiles/desktop）：activeGroup 对齐分组、补回丢失的 HX/JH 两棒（4 棒链）。

## [0.11.5] — 2026-11-15

### Fixed — 1310 重复失败指数退避 + 独立 E2E 脚本
- 残余问题（用户实测反馈）：真死 key（周上限重置在数天后）在 0.11.4 的 15 分钟平顶冷却下每周期被探测一次——选号停其上时用户每 15 分钟看到一次失败。
- 修复：1310 重复失败（24h 内）指数退避 15min→1h→6h→重置时刻；地板账号首次仍 15 分钟快速回血；非 1310 失败或超 24h 重置阶梯。
- `scripts/e2e-failover.mjs`：完全离线的端到端验证脚本（不调真实 API、不碰任何会话），6 场景 12 断言，可对仓库构建或已部署实体运行——测试不再消耗 agent 轮次。

## [0.11.4] — 2026-11-14

### Fixed — 1310 冷却封顶一个探测周期（额度地板误杀根治）
- 事故（17:25，用户实锤）：1310 有**额度地板效应**——剩余周额度可服务正常请求（实测 250K tok 通过）但对超大上下文（507K）报 1310。0.11.3 把这类账号冷却到重置时刻（两天）→ 误杀完全可用的 cn/cn-2 → 选号漂移到真死的 cn-3 → 每轮先撞尸体。
- 修复：失败消息含 1310/7 天上限时，冷却封顶 `REVIVABLE_WINDOW_MS`（15 分钟）——floor 账号分钟级回血；真死账号每周期仅花 1 个 fail-fast 探测。1308（5h 窗，重置通常 <2h）保持按重置时刻冷却。
- 回归测试：1310 冷却 ≤15min + 1308 对照。42/42。

## [0.11.3] — 2026-11-14

### Fixed — 远期冷却不再被 second-chance 反复探测（"处理失败"循环根治）
- 事故（16:38）：三账号全因 1310（重置 11-16，还剩两天）冷却后，0.11.2 的 second-chance 每 5 分钟复活一个探测——每次探测都是**必然失败的用户可见错误**（用户反复看到"处理失败"+1310）。
- 修复：复活仅当剩余冷却 ≤ 15 分钟（窗口将重置/可能已充值，探测才有价值）；远期冷却（周上限还剩数天）直接 fail-fast 不再产生噪声探测。
- `pool.remaining()` 新增；两处复活点（0.2.2 分支 + legacy 分支）同口径过滤；测试适配新语义，41/41。

## [0.11.2] — 2026-11-14

### Fixed — 全链冷却时不再烧重试预算（5/5 同路由烧录事故根治）
- 事故（11-14 14:33/14:37/14:55 三场）：cn、cn-2 相继 1310 冷却后，cn-3 再撞 1310，无健康替补 → 0.11.1 委托 llm-retry → 同一路由烧满 5 次预算 → 轮次死（用户截图实锤）。
- 修复：model.select 分支 no-healthy 路径改为 fail-fast（不烧预算）+ second-chance 复活选号（5 分钟节流，下一步自动探测恢复）。
- 回归测试复现事故场景。40/40。

## [glm-suite 0.2.1] — 2026-11-01（联网校验修复）

### Fixed
- 配置端点字段（searchMcpURL/readerMcpURL/zreadMcpURL）此前未接进 MCP 客户端（死配置）——端点变化现在自动重建客户端（会话缓存随之更换）。
- 本地 http 兜底对二进制内容（PDF/图片等）不再文本解码，显式报 unsupported（对齐官方 http provider 语义），避免向模型返回乱码。
- 移除遗留死代码（SETTINGS_NAMESPACE）。

### 调研结论（2026-11-01 联网校验）
- 社区同类插件（zhipu_plan_tools / dsh-web-search-zai）无公开 issue；官方使用须知并发/风控条款复核无新增约束。
- 重复 bundle 行为经 app-boot composeEntries 实证：同名 insert 不合并、产生双行双加载——README 明确「只保留 root bundle，勿单独再挂 dsh-glm-suite」。

## [0.9.8] — 2026-11-01

### Fixed — 装配失败外泄 + 双通道 armed + 测试隔离
- apply() 全包裹护栏：装配段任何异常先写 load.log（`apply failed: …`）再抛——0.9.7 只护了 wire，apply 前半段抛错仍会无声消失（今晚实况：模块求值✓、装配✗、无痕迹）。
- recordArmed 双通道：settings 命名空间不可用/更新失败时，兜底把 armed 快照写进 load.log——armed 状态保证外部可见。
- 测试隔离：test/loader.mjs 把 DSH_HOME 指到临时目录，测试不再污染真实 ~/.dsh/model-failover/switches.log 与 load.log。

## [0.9.7] — 2026-11-01

### Added — 加载可观测性硬化（排障盲区终局）
- 模块求值标记：宿主每次加载本插件，`~/.dsh/model-failover/load.log` 追加一行（时间/pid/版本）——"宿主到底有没有加载"从此外部可判，不依赖 GUI 日志面板。
- wire() 异常外泄：装配失败先写 load.log（含原因）再抛——armed 失败不再无声消失。
- 修正认知：dsh-scope 的 scopeTarget 对**无标签监听器全局放行**（源码注释 "admits untagged listeners globally"）——此前"子代理请求绕过根级监听器"的假设不成立，作用域接管方案撤销。

## [0.9.6] — 2026-11-01

### Added — armed 状态外部可观测
- 每次 wire() 把 `lastArmed`（时间/版本/分组/条目数/active 或 inactive+原因）写入 settings 命名空间——插件是否生效不再依赖不可见的 stdout 心跳（2026-11-01 晚排障：卡片在、零切换记录、外部无从判断 armed，盲区成本一整轮）。

## [0.9.5] — 2026-11-01

### Fixed — 切换日志迁出安装目录
- switches.log 从插件安装目录迁至 `$DSH_HOME/model-failover/switches.log`（默认 `~/.dsh/...`）：旧位置在 node_modules 内，每次重装即灭史（2026-11-01 排障时 rm+重装把当日切换历史一并删除，教训入库）。

## [0.9.4] — 2026-11-01

### Added — 版本可观测
- 启动心跳携带版本：`model-failover: v0.9.4 active group ...`——armed 判定与版本识别一步到位。
- 插件卡片描述行带版本（设置 → 插件 → Model Failover）。
- `scripts/write-version.mjs`：构建时从 package.json 生成 `src/version.ts`（单一来源，永不脱钩）；新增同步性守卫测试。

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
