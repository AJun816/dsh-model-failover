# dsh-model-failover — 设计文档

> DeepSeek Harness（DSH）多供应商 / 多账号模型自动切换插件设计
> 状态：M1 + M3（GUI）已实现并通过自动化测试；文档与 v0.5.0 代码同步，并含 M2 / M3+ / M4 的后续设计

---

## 一、结论：可以实现，且不需要任何外部代理

DSH 的 Agent Loop 原生暴露了两个"瀑布（waterfall）"扩展点，组合起来正好构成一个**请求级故障转移循环**。本设计**零外部进程、零第三方依赖、零 HTTP 代理**，全部在 Harness 进程内完成。

### 1.1 已验证的核心机制（证据）

以下结论直接读取本机安装的 DSH 实现源码验证（`@deepseek-ai/dsh-agent-loop` 0.2.1-rc.3，`lib/index.js`）：

**① `agent/request` 瀑布 —— 每次模型调用前都能改写 provider/model**（源码 L1191-1197）：

```js
const proposedConfig = await this.dispatch.waterfall("agent/request",
  { turn, step, signal },
  () => Promise.resolve(seedConfig));
if (!proposedConfig.provider || !proposedConfig.model) throw new Error(...);
```

监听器返回的 `LlmCallConfig`（`{ provider, model, reasoningEffort?, maxTokens? }`）**完整替换**当次调用的模型路由。也就是说插件可以在每一次尝试时决定"这次用哪个供应商的哪个账号"。

**关键陷阱（实战踩出）**：`agent/request` 瀑布中**最外层监听器的返回值才是最终路由配置**。`agent-default-model` 等系统插件注册在外层，轮次使用 Default 模型时会返回自己的配置、丢弃下游修改——因此本插件的 `agent/request` 监听器必须以 `{ prepend: true }` 注册抢到最外层，改写才会真正生效（`agent/request-error` 同理）。另：volatile 配置字段在热更新后以 `.get()` 引用对象形态存在，读取必须兼容两种形态。

**② `agent/request-error` 瀑布 —— 额度用完等失败发生时的决策点**（源码 L1136-1146）：

```js
const action = await this.dispatch.waterfall("agent/request-error",
  { turn, step, provider: request.provider, failure: finish.failure,
    retryPolicy: preparedCall?.retryPolicy, signal },
  () => Promise.resolve(void 0));
if (action?.kind !== "retry") throw new LlmError(...);
continue;   // ← 回到 while(true) 顶部，重新走 prepareRequest → 再次触发 agent/request
```

返回 `{ kind: "retry" }` 时，循环**回到 `prepareRequest`**，即重新触发 ① 的 `agent/request` 瀑布 —— 插件此刻切换到替补账号/替补模型，一次"失败→换号→重试"闭环就此完成，会话不中断、不停止。

**③ `llm` 服务的供应商注册能力**（Inspect 已确认的方法）：

- `llm.registerConfigurableProviders(entries)` —— 向"可配置供应商目录"注册自定义条目；
- `llm.registerAdapter(providers, adapter)` —— 为 provider 名注册适配器；
- `credentials` 服务 —— `CredentialRef` 体系存储 API Key，`credentials/record-updated` 事件可监听外部变更。

这意味着 GLM 的三个账号可以注册成三个独立凭据条目（如 `glm-1 / glm-2 / glm-3`），甚至三个 provider 条目，插件按替补顺序选用。

**④ 其余辅助能力**：`agentDefaultModel.saveSelection()`（切默认模型）、`llm/adapters-updated` 事件（拓扑变化通知）、插件 `Config`（YAML 配置，用户 patch 层升级存活）。

### 1.2 为什么不用"本地代理转发"方案

常见替代方案是起一个 OpenAI 兼容本地代理（如 one-api）让 DSH 指向它。对比：

| | 进程内插件（本设计） | 本地代理 |
|---|---|---|
| DSH 升级兼容性 | 只依赖稳定的公开瀑布/服务 API | 完全解耦，但多一个常驻进程 |
| 流式体验 | 原生（就在 `llm/stream` 管线内） | 需代理正确转发 SSE |
| 凭据管理 | 用 DSH credentials，加密存储 | 明文配置文件，需自行保护 |
| 依赖 | **零**（纯 JS 单文件插件） | 一个 Go/Node 常驻服务 |
| 故障定位 | DSH 日志内一体可见 | 跨进程排障 |

代理方案的唯一优势是与 DSH 完全无关；但它违背"低依赖"要求，且丢失 DSH 的凭据与会话日志集成。**本设计选择进程内插件。**

---

## 二、总体架构

```
┌────────────────────────── DSH Host ──────────────────────────┐
│                                                              │
│  AgentLoop.step() ──► agent/request 瀑布 ──► LLM 适配器       │
│        ▲                    │                     │          │
│        │            ┌───────▼────────┐      402/429/额度错误  │
│   {kind:"retry"}    │ 本插件          │            │          │
│        │            │ RoutePlanner   │◄─ agent/request-error │
│        └────────────┘  · 账号池状态机  │      瀑布(prepend)    │
│                       · 替补顺序表    │                      │
│                       · 冷却/恢复     │                      │
│                       │ 配置(Config)  │                      │
│                       │ 凭据(credentials)                    │
└──────────────────────────────────────────────────────────────┘
         ▲ remote.settings / remote.session.modelCatalog
         │
┌────────┴───────── Web GUI（设置 → 插件 卡片）─────────────────┐
│  分组/条目编辑 · 上下移排序 · 冷却与触发类别 · 自动模式预览      │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 组件（均为已实现状态）

1. **Config（YAML 配置，schemastery schema，全部字段 `volatile`）** —— 用户在 `cordis.patch.yml` 的 patch 层维护。字段：`groups`（有序替补链）、`activeGroup`、`cooldownMinutes`（默认 30）、`retryOn`（默认 `[quota, rate-limit, auth, network]`）、`autoDiscover`（默认 true：未配置分组时，目录中每个已配置 provider 自动入链）。

2. **账号池状态机（AccountPool，`createPool`）** —— 冷却按 **provider（账号）** 维度记录：
   - `cool(account, ms)`：写入到期时间，**只延长不缩短**（供应商 Retry-After 更长则按更长者）；
   - `isCooling(account)`：惰性检查，到期即自动删除恢复 `healthy`；
   - `recover(account)`：成功后立即恢复；
   - `snapshot()`：导出各账号到期时间（为 M3+ 状态展示预留）。

3. **错误分类器（`classifyFailure`）** —— 三级匹配，优先级从高到低：
   - `code` 正则：`QUOTA / ACCOUNT_QUOTA → quota`，`RATE_LIMIT → rate-limit`，`AUTH* → auth`，`NETWORK/TIMEOUT/CONNECTION* → network`；
   - HTTP status：402→quota，429→rate-limit，401/403→auth，503/504/529→network；
   - `message` 关键词兜底（含中文"额度/余额/服务繁忙"）。
   未命中归类 `other`，不触发切换，透传 DSH 原生行为（避免为上下文超长之类的问题换号）。

4. **RoutePlanner（`apply()` 内的两个监听器）**：
   - **`agent/request`**：先 `await next()` 拿到已解析配置，再按激活分组顺序取**第一个非冷却条目**改写路由。跨 provider 改写时只保留中立字段（`maxTokens`、`temperature`），避免 A 家的专属参数发给 B 家；同 provider 只换 model 时透传原配置。选中条目记入 `inFlight`（按 agent 会话键）。
   - **`agent/request-error`（`prepend: true` 注册，永远先于 llm-retry 等下游恢复策略执行）**：
     1. 分类失败，未命中 `retryOn` → 直接 `next()` 透传；
     2. 定位失败账号：优先 `inFlight` 记录，兜底回环报告的 `provider`；无法定位则透传；
     3. 冷却该账号（`max(cooldownMs, Retry-After)`）；
     4. **总是先 `next()` 委托下游**：若下游（如内置 llm-retry）自己决定 retry，尊重其退避决策（其 retry 会重新进入 `agent/request`，自然跳过已冷却账号）；
     5. 下游无恢复决策时，检查**重试预算**（同一 agent|turn|step 的换号次数以分组大小为上限，杜绝重试风暴），预算内且有健康替补 → 返回 `{ kind: 'retry' }` 并打切换日志；预算耗尽或全灭 → 返回下游结果，交回 DSH 默认错误处理。

5. **自动发现（autoDiscover）** —— 未配置分组时，通过公开 `llm.listProviders() / listModels()` 把每个已配置 provider（各取第一个模型）按目录顺序组成 `auto` 链；监听 `llm/adapters-updated` 事件在拓扑变化时刷新。目录不可用时链为空、插件静默不激活。

6. **配置热重载** —— 所有监听器在 `ctx.effect(wire)` 中装配：cordis 检测到 volatile 配置变化即销毁旧 fiber 重建监听器，**冷却状态刻意存活于重装配**，GUI 保存即时生效、无需重启。

7. **GUI（M3，`src/client.tsx`，v0.3.0+）** —— 设置 → 插件 页卡片：
   - 走通用 `remote.settings.describe/update` RPC 读写 `model-failover` 命名空间（带 revision 乐观并发控制，多窗口冲突可检测）；
   - `remote.session.modelCatalog()` 拉取 provider/model 目录做下拉与 datalist 补全，并展示 routable 状态点；
   - 分组增删改名、条目上移/下移排序、一键"从目录生成替补链"、按 `provider-2/-3` 命名惯例复制条目（对应多账号）；
   - 自动模式（groups 为空）展示按目录顺序、默认路由优先的预览链；
   - 校验（未命名分组 / 条目不完整 / 冷却时长下限）不通过则禁用保存。

8. **可观测性** —— 每次切换 `ctx.logger.info` 一条（谁→谁、原因分类、冷却分钟数）；放弃切换 `warn`（全灭 / 预算耗尽 / 自动发现失败）。

### 2.2 一次故障转移的时序

```
step#3: agent/request → RoutePlanner 选 glm-1
        请求发出 → 402 Insufficient Balance
        agent/request-error(prepend, quota) → glm-1 置 cooling(30min)
        → 下游 llm-retry 无决策 → 返回 {kind:"retry"}
step#3(重试): agent/request → 选 glm-2 → 成功，继续流式输出
```

用户感知：任务不停止，日志里多一行 `model-failover: glm-1/glm-4.7 failed (quota) → switching to glm-2/glm-4.7 (cooldown 30 min)`。

### 2.3 防御式降级（插件故障 = 未安装）

- 每个监听器整体 try/catch：`agent/request` 内异常原样上抛（等价于未改写路由）；`agent/request-error` 内异常 `return next()`；
- `llm` 服务通过 `static inject` 注入，目录方法调用各自 try/catch；
- 未知 payload 形状（agent 键无法定位）一律透传不盲试。

---

## 三、低依赖策略（升级不坏）

1. **只依赖公开稳定扩展点**：`agent/request`、`agent/request-error` 两个瀑布 + `llm` 公开目录方法 + `remote.settings/session` 通用 RPC。不 import 任何 DSH 内部模块。
2. **类型零耦合**：`LlmCallConfig / LlmFailure` 只做 type-only import；瀑布 payload、recovery action、cordis Context 均为本地结构化声明，对任意已发布 `@deepseek-ai/dsh-agent` 版本可编译（升级容错）。
3. **配置放插件 Config（patch 层）**：DSH 升级重组默认配置时用户 patch 存活。
4. **近零依赖**：运行时仅 `@deepseek-ai/schemastery`（本身零依赖）；TypeScript、官方类型包、esbuild、react 全在 devDependencies；`lib/` 编译产物直接入库，GitHub 安装零构建。
5. **版本约束宽**：未来若瀑布事件更名，插件以"不激活 + 日志告警"的方式失败，而非崩溃。

---

## 四、分期与现状

| 阶段 | 内容 | 状态 |
|---|---|---|
| M1 | Config 账号池 + 双瀑布监听 + 错误分类 + 冷却状态机 + 重试预算 + 日志 + 测试 | ✅ 已实现（18 项测试） |
| M3 | 设置 → 插件 GUI 卡片（分组/条目编辑、排序、冷却与触发类别、自动模式预览，保存即时生效） | ✅ v0.3.0 已实现 |
| 增强 | 自动发现替补链（autoDiscover）、与 llm-retry 协同（prepend + 总是委托）、Retry-After 取长、中立字段过滤、配置热重载 | ✅ 已实现 |
| M2 | `llm.registerConfigurableProviders` 注册 glm-1/2/3 条目，设置页可发现；`agentDefaultModel` 联动 | ⬜ 见 §五 |
| M3+ | GUI 内展示各账号实时冷却状态 | ⬜ 见 §六 |
| M4 | 用量统计与额度预警 | ⬜ 见 §七 |

---

## 五、M2：多账号 provider 注册（v0.6.0 已实现客户端路径）

目标：让"GLM 三个账号"不必手工在 DSH 里配三个 provider。v0.6.0 已通过 GUI "多账号 / Account Pool" 实现（纯客户端，走通用 RPC，无自定义 Host API）：

1. **复制账号**：卡片自动识别系统已配置的供应商（`session.modelCatalog`）；用户点「复制」只需填一把新 API Key。流程：`settings.mutate('llm-pi-ai', [{op:'set', path:['providers', base-2], value: 克隆的 profile + apiKeyEnv}])` + `credentials.set(deriveKeyRef('base-2'), key)`（与 Models 页同约定：`glm-2 → GLM_2_API_KEY`）；手动替补链中副本自动插到原账号之后，自动模式无需干预。
2. **账号列表**：每供应商一张卡（Key 状态点、已加账号数）；副本行支持换 Key（`credentials.set`）与删除（`op:'unset'` + `credentials.unset` + 从分组移除）。
3. **密钥安全**：Key 只进加密凭据库，配置里只有 env 引用；settings describe 的密文脱敏不受影响。

Host 侧 `registerConfigurableProviders` 声明式注册（目录可发现性）仍为可选后续。

1. **配置扩展**（保持向后兼容，全部可选）：

   ```yaml
   model-failover:
     registerProviders:
       - id: glm-1                      # 注册进目录的 provider 名
         base: glm                       # 模板：复用已注册 glm provider 的适配器/baseURL
         label: "GLM 账号 1"
       - { id: glm-2, base: glm, label: "GLM 账号 2" }
   ```

2. **注册流程**：`apply()` 启动时对每条 `registerProviders`：以 `base` 指向的现有 provider 为模板调用 `llm.registerConfigurableProviders` 派生条目（同 baseURL、独立凭据位）；凭据键约定 `llm:{id}/api-key`，写入 `credentials` 服务。
3. **凭据联动**：监听 `credentials/record-updated`——某账号 key 被外部更换/删除时，若正处于冷却则 `pool.recover`，让新 key 立即可试。
4. **`agentDefaultModel` 联动（可选开关 `followDefault: true`）**：默认模型路由变化时，若其 provider 在替补链中则把该 provider 提到链首，保持"默认优先"。
5. **降级**：`registerConfigurableProviders` 不存在或注册失败 → warn 一条并跳过该条目，其余功能不受影响。

## 六、M3+ 设计：GUI 冷却状态（待实现）

需要 Host 主动暴露 `pool.snapshot()`，走插件自定义 Remote 服务（通用 settings RPC 只有配置，没有运行态）：

1. **Host 侧**：插件注册 `remote 'model-failover'`，提供 `status(): { accounts: { provider, coolingUntil }[], activeGroup, autoChain } `；用 cordis 事件 `model-failover/updated` 在每次冷却/恢复时推送。
2. **Client 侧**：卡片底部新增"账号健康"区：每行 provider + 状态点（绿=健康 / 黄=冷却）+ 倒计时（`coolingUntil - now`，每秒本地刷新，避免轮询）；全灭时整行置灰并提示"全部冷却中，等待自动恢复"。
3. **降级**：Remote 未就绪（旧版 Host / 插件未激活）时该区块显示"—"，编辑功能不受影响。

## 七、M4 设计：用量统计与额度预警（可选，待实现）

1. **采集**：在 `agent/request` 监听处顺带记录（provider, model, ok/fail, 耗时）到内存环形缓冲（按天聚合，重启即清，不落盘——保持零依赖、不碰用户数据）。
2. **展示**：复用 §六 的自定义 Remote：卡片显示各账号今日请求数 / 失败率 / 冷却次数。
3. **预警**：连续 N 次额度类失败且剩余健康账号 ≤1 时 `logger.warn` + GUI 卡片顶部黄条提醒"替补即将耗尽"。
4. **明确不做**：余额查询（需各供应商专属 API，违背低依赖）。

---

## 八、风险与边界

- **`LlmFailure.code` 的具体枚举**：已按 code 为主、status 与 message 关键词兜底的三级分类实现；新错误码出现时归 `other` 透传，不会误切换。
- **同供应商多账号**：目前要求每账号一个独立 provider 名（如 glm-1/2/3）；M2 落地后可由插件声明式注册，免手工。
- **跨供应商切换的能力差异**（工具调用格式等）由 DSH 适配器层吸收，插件只换路由不碰消息体 —— 这正是选 `agent/request` 而非 `llm/stream` 改写的原因。
- **瀑布 payload 形状演进**：全部按结构化可选字段读取，缺字段即透传；DSH 未来加字段不破坏本插件。
- **预测性切换不做**：只做失败响应式切换，简单可靠。

---

## 九、GitHub 仓库名

**推荐：`dsh-model-failover`**（已采用）

理由：`dsh-` 前缀表明生态归属（与 `dsh-llm`、`dsh-agent-preset` 等官方包命名一致，易被检索）；`model-failover` 直接点明业务（模型故障转移/替补）。

一句话仓库描述（About）：
> DeepSeek Harness plugin: automatic model & account failover across providers (DeepSeek, GLM multi-account, …) when quota runs out — zero dependencies.
