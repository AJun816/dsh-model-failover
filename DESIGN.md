# dsh-model-failover — 设计文档

> DeepSeek Harness（DSH）多供应商 / 多账号模型自动切换插件设计
> 状态：设计定稿（基于 DSH 0.2.1-rc.3 实测源码验证）

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
│        └────────────┘  · 账号池状态机  │      瀑布            │
│                       · 替补顺序表    │                      │
│                       · 冷却/恢复     │                      │
│                       │ 配置(Config)  │                      │
│                       │ 凭据(credentials)                    │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 组件

1. **Config（YAML 配置）** —— 插件声明 `static Config`（schemastery/zod schema），用户在 `cordis.patch.yml` 的 patch 层维护。按 practices 规范："可调值放 Config，用户 patch 层在升级后存活" —— 这是低依赖的第一道保障。

   ```yaml
   # 用户侧配置示例（cordis.patch.yml）
   model-failover:
     groups:
       - id: glm-pool
         entries:                 # 替补顺序即数组顺序
           - provider: glm-1      # 每个账号一个 provider 条目
             model: glm-4.7
           - provider: glm-2
             model: glm-4.7
           - provider: glm-3
             model: glm-4.7
       - id: cross-provider       # 跨供应商兜底链
         entries:
           - provider: deepseek
             model: deepseek-chat
           - provider: glm-1
             model: glm-4.7
     activeGroup: glm-pool
     cooldownMinutes: 30          # 判定"没额度"后的冷却时长
     retryOn: [quota, rate-limit, auth, network]
   ```

2. **账号池状态机（AccountPool）** —— 每个条目三态：`healthy / cooling / dead`。
   - 任何一次以该条目为目标的请求失败且错误分类命中 `retryOn` → 置 `cooling`，记录到期时间；
   - `cooling` 到期自动回 `healthy`（额度按天/月重置，冷却比永久拉黑更合理）；
   - 请求成功 → 立即回 `healthy`。

3. **错误分类器（FailureClassifier）** —— 把 `agent/request-error` 的 `failure`（`LlmFailure`，含 `code` 与 `message`）映射为四类：`quota`（402/1113/"Insufficient Balance"）、`rate-limit`（429）、`auth`（401/403/key invalid）、`network`/`unknown`。只对配置允许的分类触发切换，其余（如 `context-length`）透传原行为，避免为 Bug 换模型。

4. **RoutePlanner（核心监听器）**：
   - `agent/request`：按当前激活 group 的顺序，返回**第一个 `healthy`** 条目的 `{provider, model}`（并透传 `reasoningEffort/maxTokens`）；
   - `agent/request-error`：分类失败 → 标记当前条目 `cooling` → 还有健康条目则返回 `{kind:"retry"}`，全灭则返回默认动作（让 DSH 报错，并发出通知事件）。

5. **凭据** —— 每个账号一条 `credentials` 记录（如 `llm:glm-1/api-key`），复用 DSH 的加密存储；插件 UI（可选二期）只是这些凭据记录 + Config 的编辑界面。

6. **可观测性** —— 每次切换用 `ctx.logger` 记录一条（谁→谁、原因、冷却到期时间）；可选监听 `session/event` 做用量统计。

### 2.2 一次故障转移的时序

```
step#3: agent/request → RoutePlanner 选 glm-1
        请求发出 → 402 Insufficient Balance
        agent/request-error(quota) → glm-1 置 cooling(30min)
        → 返回 {kind:"retry"}
step#3(重试): agent/request → 选 glm-2 → 成功，继续流式输出
```

用户感知：任务不停止，日志里多一行 `model-failover: glm-1 → glm-2 (quota, cooldown 30m)`。

---

## 三、低依赖策略（升级不坏）

1. **只依赖公开稳定扩展点**：`agent/request`、`agent/request-error` 两个瀑布 + `llm.registerConfigurableProviders` + `credentials`。这些都是插件契约（practices.md 明示为插件可用机制），不是内部函数。
2. **可选服务全部走 `ctx.inject` / `static inject` 可选注入**（practices 规范）：目标 provider 条目不存在时不 throw，插件静默不激活，DSH 缺服务也不拖垮启动。
3. **配置放插件 Config（patch 层）**：DSH 升级重组默认配置时用户 patch 存活。
4. **纯 JS 单包，`dependencies: {}`**：不引 zod/schemastery 之外的任何运行时依赖（schema 用 DSH 自带 schemastery peer）。无构建步骤也可发布（直接 JS）。
5. **防御式降级**：所有监听器包 try/catch，异常时 `return next()` 透传，插件故障 = 回到无插件行为，绝不阻断模型调用。
6. **版本约束宽**：`engines.dsh` 只要求满足瀑布事件存在的最低版本（0.2.x），未来若事件更名，插件以"不激活+日志告警"的方式失败，而非崩溃。

---

## 四、MVP 分期

| 阶段 | 内容 |
|---|---|
| M1（最小可用） | Host-only 插件：Config 定义账号池 + `agent/request`/`agent/request-error` 两个监听器 + 错误分类 + 冷却状态机 + 日志。无 UI。 |
| M2 | `llm.registerConfigurableProviders` 注册 glm-1/2/3 条目，让设置页可发现；`agentDefaultModel` 联动一键切换默认模型。 |
| M3（可选） | Web UI：设置页 Slot 里管理替补顺序、查看各账号健康状态/冷却倒计时。 |
| M4（可选） | 用量统计（`session/event` projection）与额度预警提醒。 |

M1 大约 300–400 行纯 JS，一个下午可完成。

---

## 五、风险与边界

- **`LlmFailure.code` 的具体枚举**需在实现时用一次真实 402/429 验证分类准确性（设计上以 code 为主、message 关键词兜底）。
- GLM 三账号若共用同一 provider 名（同一 base URL 不同 key），需要 `registerConfigurableProviders` 支持同 baseURL 多条目，或为每账号注册独立 provider 名 —— 实现时二选一验证。
- 替补切换跨供应商时，模型能力差异（如 GLM↔DeepSeek 的工具调用格式）由 DSH 适配器层吸收，插件只换路由，不碰消息体 —— 这正是选 `agent/request` 而非 `llm/stream` 改写的原因（更弱、更稳的机制）。
- 额度"预测性"切换（提前发现余额不足）不做，只做失败响应式切换 —— 简单可靠。

---

## 六、GitHub 仓库名

**推荐：`dsh-model-failover`**

理由：`dsh-` 前缀表明生态归属（与 `dsh-llm`、`dsh-agent-preset` 等官方包命名一致，易被检索）；`model-failover` 直接点明业务（模型故障转移/替补），比 `switcher`/`router`/`pool` 更准确地表达"额度用完自动切换"这一核心诉求。

备选：
- `dsh-llm-failover` —— 同样准确，与 `dsh-llm` 包呼应；
- `dsh-model-relay` —— 强调"接续"，但 relay 易被误解为代理转发；
- `dsh-multi-account-llm` —— 突出多账号，但偏长且弱化"自动切换"。

一句话仓库描述（About）：
> DeepSeek Harness plugin: automatic model & account failover across providers (DeepSeek, GLM multi-account, …) when quota runs out — zero dependencies.
