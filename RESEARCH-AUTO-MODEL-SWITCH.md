# 研究：按输入类型自动切换模型（图片 → 视觉模型 → 回切默认模型）

> 状态：**可行性研究完成，未开发**。基于本机 DSH Desktop 0.2.1-rc.5 实测源码（app.asar 解包验证）。
> 结论先行：**可以实现**，且本插件（dsh-model-failover）已具备实现它所需的全部"地基"能力；
> 唯一的硬门槛是"图片准入检查"发生在会话控制器（早于 Agent Loop），需要三选一的绕行策略。

---

## 一、需求还原

- 默认模型 `= glm-5.3`（文本，擅长复杂编码）；视觉模型 `= glm-5.3flash`（套餐内、支持图片）。
- 用户发截图 + 文字 → 系统自动用 flash 识别图片 → 之后自动回到 glm-5.3 继续编码。
- 全程用户不感知模型切换；插件可配置"每种场景用哪个模型"。

## 二、现状：用户看到的报错从哪来（三道关卡）

### 关卡 1（用户报错的直接来源）：会话控制器在"准入"时硬拒绝

`dsh-api-session-controller/lib/index.js` L937-941（0.2.1-rc.5 实测）：

```js
async prompt(request, source) {
    const hasImage = request.content.some((part) => part.type === "image");
    // ... admit() 内部：
    if (hasImage) {
        const current = this.agents.selectionFor(agent).current;   // ← 会话当前模型选择
        const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model);
        if (model.inputModalities !== void 0 && !model.inputModalities.includes("image"))
            throw new RemoteError("session/attachment-invalid",
                `Model "${current.model}" does not support image input.`,
                { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" });       // ← 就是它
    }
    ...
}
```

- 客户端 `dsh-client-ui-conversation` 把该错误码渲染为 `image.modelUnsupported`（"模型不支持图片"）。
- 关键：**此检查在 Agent Loop 启动之前**。也就是说，即使插件能在 Loop 内每请求改路由（我们已具备），
  只要"会话当前选择"是文本模型，带图消息根本进不了循环。
- `current` 的取值链（L273-313）：会话内待消费选择 → **上一次请求头里的模型** → 全局默认模型。
  注意第二跳：只要会话曾用 glm-5.3 发过请求，之后发图就会再次被拒——"只在全局默认上做文章"不够。

### 关卡 2：子代理（subagent）路径有同样的检查

`dsh-subagent` L2242 / manager L1284：给子代理发图同样要求模型 `inputModalities` 含 `image`。首期可不管，但设计要留位。

### 关卡 3：LLM 层的"文本模型图片投影"

`dsh-llm/lib/index.js` L2337：

```js
if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image")
    && projectedMessages.some((m) => contentHasImage(m.content)))
    projectedMessages = projectImagesForTextModel(projectedMessages);
```

- 文本模型收到的历史图片会被替换为 `[image omitted because this model accepts text only; attachment sha256:…]`。
- 推论：**单纯"图片轮用 flash、下一轮回切 glm-5.3"时，历史里的原图对 glm-5.3 是不可见的**，
  glm-5.3 只能依赖 flash 当轮输出的文字。这对"看截图改代码"多步任务是真实的体验损失（见方案 B）。

## 三、可用的官方扩展点（全部有源码证据）

| 扩展点 | 证据（0.2.1-rc.5） | 对本需求的价值 |
|---|---|---|
| `agent/pre-step` 瀑布 | dsh-agent-loop L905-925：payload 含 `messages`（本步新认领的用户消息）+ `agent`；监听器返回值中的 `messages` 会被原样写入会话日志（L1070-1077） | ① 感知"本步是否带图"（含工具结果里的图）② 可改写消息内容（转写方案的挂点） |
| `agent/request` 瀑布 | dsh-agent-loop L1191：每步每次尝试都会走；返回的 `{provider, model, …}` 完整替换当次路由 | 按步路由：带图步 → flash，纯文本步 → 默认模型。**本插件已用 prepend 验证此机制** |
| `agent/request-error` 瀑布 | L1136-1146：返回 `{kind:"retry"}` 会回到 prepareRequest 重新走路由 | flash 额度/限流时自动降级（与现有故障转移链天然融合） |
| 事件 payload 自动带 `agent` | dsh-agent L243-271（agentEvents 把 `agent` 融进每个事件） | 按 agent 会话键记账（插件 inFlight 已这么干） |
| `llm` 服务公开 API | resolveModelInfo L2111 / resolveCallConfig L2174 / prepareCall L2220 / **stream L2393** | ① 查询任意模型的 `inputModalities`（路由依据）② 插件可直接调 flash 做"图片转写" |
| `attachments` 服务 | 会话控制器经 `ctx.inject(["attachments"])` 使用；`readImage(ref)` 可取回字节 | 转写时读取持久化的图片附件 |
| 模型目录的模态元数据 | dsh-llm-pi-ai：`inputModalities` 来自 provider 配置的 `models[].input`；Models 设置页可逐模型勾选（settings-models client L251/L868） | glm-5.3flash 今天就能被标记为图片模型（用户手配或插件代写 `llm-pi-ai` 命名空间——插件已在写这个命名空间） |
| 客户端 remote face | api-remotes client：`session.prompt / session.selectModel / session.modelCatalog`；图片随 prompt RPC 内联 base64 传输（conversation client L4700-4737） | 客户端编排方案的动作面 |
| 客户端插件注入 | package.json `dsh.client.inject` + dsh-client-modules（插件 bundle 与宿主模块同表加载） | 让插件客户端代码进入会话页面执行（编排/包裹的前提） |

另外两条与体验直接相关的既有行为：

- 图片预算/卸载：`IMAGE_OFFLOAD_REQUIRED_CODE`、`dsh-compaction-image-offload`——图片在历史里占预算，超限会触发卸载（转写方案顺带解决）。
- 请求头按次记录实际模型：会话日志/轨迹对"同一轮次内模型变化"是原生支持的（现有 failover 换模型已在产生这种日志）。

## 四、候选方案

### 方案 A：请求级路由（routing）

`agent/pre-step` 监听器给每个 agent 记"本步消息是否含图"（用 dsh-llm 同款递归判断，
**必须走 tool-result 内容**——`read_image` 工具结果就是图片块）；`agent/request`（prepend）据此改写：
带图步 → 视觉模型，否则 → 默认模型。与现有 failover 逻辑合并进**同一个 prepend 监听器**（场景路由优先，再套故障转移），避免两个 prepend 监听器的次序问题。

- ✅ 机制全部已被本插件验证（每请求改写、跨供应商改字段、失败换号重试）。
- ✅ 额外红利：`read_image` 工具结果也是图片——文本默认模型下该工具结果会被投影成占位符（等于废掉）；
  本方案让带图工具结果的步骤自动走 flash，`read_image` 在"默认模型是文本模型"的会话里真正可用。
- ⚠️ 关卡 1 未解决（准入在 Loop 之前）；关卡 3 造成"回切后历史图片不可见"。

### 方案 B：转写管线（transcription，最贴合用户描述的体验）

`agent/pre-step` 监听器：发现新认领消息里有图片块 → 读图（`attachments.readImage`）→
用 `llm.stream` 调视觉模型生成"给编码代理看的详尽描述" → 把图片块替换/注释为文字（或附加描述文本块）。
之后所有步骤照常走默认模型 glm-5.3，不再需要路由切换。

- ✅ 彻底解决关卡 3（历史里只有文字，任何后续步骤、压缩、长任务都不丢图片信息）。
- ✅ 顺带把图片 token 成本一次性化（后续轮次不再带图，也不触发图片卸载）。
- ✅ 与 failover 完全正交（转写调用本身也可挂故障转移）。
- ⚠️ 仍受关卡 1 制约（准入检查发生在转写之前）；多一次 flash 调用延迟（约 1-3s/图）；
  转写质量决定下游编码质量（prompt 要按"编码代理视角"精心设计，保留布局/文字/颜色/路径等细节）。
- ⚠️ pre-step 改写会改变落盘的用户消息（UI 气泡里图片预览消失→变成文字）。可保留原图片块仅追加描述块缓解。

### 关卡 1 的三种绕行策略（A/B 方案都需要，三选一）

| 策略 | 做法 | 代价/风险 |
|---|---|---|
| ① 客户端编排（推荐主选） | 插件客户端检测"编辑器有图 + 当前选择是文本模型" → 发送前调 `session.selectModel(flash)`，图片轮结束后调回默认模型。`serializeImageAdmission`（L341）本就串行化"图片准入与模型选择"，时序安全 | **没有官方的"发送前钩子"**：需注入 conversation 模块并包裹其 send/remote 调用（`dsh.client.inject` 同表加载使其技术可行），依赖未文档化内部结构，DSH 升级需回归 |
| ② 模态声明 + 强制路由（零代码兜底） | 在 provider 配置里把 glm-5.3 的 `input` 声明为含 `image`（Models 页即可改）。准入检查通过；图片步由插件**强制**路由到 flash，glm-5.3 实际永不收图 | 声明是"善意的谎言"：绕过路由的路径（如子代理、异常兜底）会把图真发给文本端点→供应商报错。需把"带图必路由"做成硬不变量 |
| ③ 补丁 resolveModelInfo（不推荐，仅记录） | 插件运行时包裹 `ctx.llm.resolveModelInfo`，仅对准入场景谎报模态 | 猴补丁公共服务方法，影响面不可控（选型器、子代理、压缩都会看到谎言），升级脆弱 |

### 推荐组合

**M1：方案 A + 策略①**（体验完整：准入过、图片步走 flash、文本步走默认、失败自动降级）；
**M2：加方案 B 作为可选开关**（"图片转写后全程默认模型"，长任务/省 token 场景）；
策略②作为客户端钩子失效时的降级路径写进文档。

## 五、配置设计（扩展现有 YAML/GUI）

```yaml
model-failover:
  scenarios:            # 场景 → 模型路由表（新增）
    default:   { provider: glm-1, model: glm-5.3 }        # 纯文本/编码
    vision:    { provider: glm-1, model: glm-5.3-flash }   # 含图片输入的步骤
    # 未来可扩：long-context / cheap-tool 等场景
  visionMode: route     # route=方案A | transcribe=方案B（M2）
  transcribePrompt: ''  # 方案B 的转写提示词（空=内置默认）
```

- 场景模型同样进入故障转移链：flash 挂了按现有 retryOn 分类换下一家（视觉能力可用
  `llm.resolveModelInfo(...).inputModalities` 在建链时校验，只把声明了 image 的条目放进 vision 链）。
- GUI 卡片加"场景路由"区（沿用现有卡片风格，下拉选 provider/model，带图片能力徽标）。

## 六、风险与未决问题（开发前需逐项验证）

1. **客户端发送钩子的具体挂法**（策略①的最大不确定点）：包裹 conversation 的
   `session.prompt` 还是更底层的 remote face？升级兼容窗口多大？→ M1 第一周先做 spike。
2. `agent/pre-step` 的 `messages` 精确形状（含 steer 消息、runtime-context 消息的排序）与
   "本步带图"状态在 pre-step → request 之间的传递是否在所有路径下成立（aborted/steer/唤醒）。
3. pi-ai 适配器向 flash 发图的实际编码路径（`imageRequestTarget` 默认原样；GLM 端点对
   base64/URL 的接受度、尺寸与预算限制）。
4. 会话日志/UI 对"轮内模型切换"的呈现（现有 failover 已产生此类日志，确认轨迹页显示友好）。
5. 子代理路径（关卡 2）是否纳入 M1：子代理模型选择器的改写挂点待查。
6. 转写方案的落盘语义：替换 vs 追加描述块；UI 气泡呈现；`session/attachment` 预览授权不受影响。
7. flash 与默认模型分属不同账号/供应商时的凭据与计费归因（现有 credentials/CredentialRef 体系直接可用，但要在 GUI 展示清楚）。
8. **（2026-11-01 实测新证）pi-ai 的 provider 配置（baseURL / models / input 模态）不热加载**：直接编辑 profiles/desktop/cordis.patch.yml 后约 40 秒内对运行中的适配器无效（故障注入实验验证）。影响：策略②的模态声明、策略①依赖的 provider 画像变更，都需要宿主重读配置的路径（应用重启、插件重载、或改走 remote.settings RPC 写入而非直接改文件），实现时必须内置这一探测。

## 七、分期建议

- **M0（spike，1-2 天）**：验证策略①钩子挂法 + pre-step/request 联动改路由的最小闭环（硬编码模型对）。
- **M1**：场景路由配置 + GUI + vision 链故障转移 + `read_image` 工具结果自动升级路由 + 切换日志。
- **M2**：转写模式（方案 B）开关与提示词配置、图片预算收益对比、（可选）子代理覆盖。

## 八、升级兼容性设计：能否保证不产生强依赖

**结论：可以做到"升级不坏"，前提是把每个触点分级管理；本节以跨版本源码 diff 的实证数据为依据。**
设计总原则（继承自本插件既有的"低依赖策略"，DESIGN §三）：**任何触点失效时，行为退回 DSH 原生表现（fail-closed to stock），最坏情况 = 没装本功能的今天，永不更坏。**

### 8.1 触点分级清单

| 级别 | 触点 | 现状 | 降级策略 |
|---|---|---|---|
| **A：公开契约，本插件已在用并跨版本存活** | agent/request / agent/request-error 瀑布、ctx.effect/logger、插件 Config(patch 层)、remote.settings/credentials 通用 RPC、appendPluginRecord、插件卡片插槽 | 0.1.x→0.2.1-rc.5 实际存活（DESIGN 针对 rc.3 编写、现跑 rc.5 无需改动） | 与今日插件同风险：payload 形状陌生即透传 + 日志告警，不崩溃 |
| **B：公开服务/瀑布，本功能首次使用** | agent/pre-step 瀑布；llm.resolveModelInfo / resolveCallConfig / stream 直调；attachments.readImage；remote.session.selectModel；llm-pi-ai 命名空间（**插件今天已在写它**，多账号管理即用） | 签名/形状在 0.0.1-rc.1 与 0.2.1-rc.5 间完全一致（见 8.2） | 每个触点独立 try/catch + 能力探测：pre-step 缺 messages 字段→不标记带图；转写失败→退回路由模式；readImage 失败→跳过转写；selectModel 失败→卡片提示手动模式 |
| **C：未文档化内部结构** | 仅一处：客户端发送钩子（策略①包裹 conversation 发送流） | 无官方发送前钩子 API | 见 8.4：做成"非承重墙"——渐进增强，失败自动降级到策略②，再失败降级到指引手动切换 |

**明确放弃**：策略③（运行时补丁 llm.resolveModelInfo）正是典型的强依赖做法（猴补公共服务、影响面波及选型器/子代理/压缩），从候选中**剔除**，并写入编译产物守卫测试禁止此类模式（见 8.5）。

### 8.2 跨版本稳定性实证（本机可得的三个版本源码 diff）

| 契约 | 0.0.1-rc.1 / 0.1.x（旧） | 0.2.1-rc.5（当前 app） | 结论 |
|---|---|---|---|
| agent/pre-step 瀑布 payload | {messages, turn, step, signal}（agent-loop 0.1.5-rc.2 L894） | 同（L909） | 形状未变 |
| agent/request 瀑布 payload | {turn, step, signal}（L1143） | 同（L1191） | 形状未变 |
| agent/request-error 瀑布 | 存在（L1088） | 存在（L1136） | 未变 |
| 事件 payload 融合 agent 键 | dsh-agent 0.1.0-rc.6 agentEvents 即融合 | 同 | 未变 |
| llm.resolveModelInfo(provider, model, signal) 返回含 inputModalities | 0.0.1-rc.1 L1163 即如此 | 同 | 签名未变 |
| llm.stream / prepareCall / resolveCallConfig | 0.0.1-rc.1 齐备 | 齐备 | 未变 |

解读：**核心瀑布与 llm 服务面自 0.0.x/0.1.x 起就是稳定契约**；相反，图片准入检查、pi-ai 模态配置属于较新的 rc 期特性（0.0.1 的 dsh-llm 仅导出 contentHasImage 尚未内部使用），**churn 风险集中在这一年轻层**——因此对该层的依赖必须全部走 B 级降级模式 + 金丝雀监控，而非假设稳定。

### 8.3 B 级触点的"能力探测"模式（沿用本插件既有代码风格）

```ts
// 伪代码：每个新触点都遵循 probe → use → degrade 三段式
const offPreStep = ctx.on('agent/pre-step', async (payload, next) => {
  const base = await next()                       // 永远先委托下游
  try {
    const msgs = payload?.messages
    if (!Array.isArray(msgs)) return base         // 形状陌生：当作没有图片信息
    pendingImage.set(agentKey(payload), msgs.some(hasImageBlock))
    return base                                   // M1 路由模式不改消息
  } catch { return base }                         // 任何异常 = 未安装本功能
})
```

配套要求：hasImageBlock 本地实现（含 tool-result 递归，共约 6 行，不 import dsh-llm）；所有新 payload/消息块类型一律**本地结构化声明**（type-only），运行时零 DSH 模块 import——延续 DESIGN §三.2 的"类型零耦合"。

### 8.4 唯一的 C 级触点（客户端发送钩子）如何不成为承重墙

1. **渐进增强定位**：Host 侧路由/转写（全在 A/B 级）是功能主体；客户端钩子只负责"发送前自动 selectModel 过准入关"这一步便利性。钩子装不上 → 自动降级策略②（写 provider 模态声明，纯 settings 写入，插件今天已在写该命名空间）；再装不上 → 卡片显示"检测到图片，请手动切 flash"一键指引。**三级降级路径全部自动探测、自动切换，无需用户排障。**
2. **自检与指纹**：钩子安装后自验证包裹是否生效；记录所包裹函数的指纹（toString 哈希），DSH 升级导致指纹变化 → 主动进入保守模式并告警，而非带着失效假设继续跑。
3. **策略②的 fail-closed 联锁**：模态声明是"善意的谎言"，必须与"带图必路由"不变量绑定——路由监听器若未成功安装（或升级后失效），插件**自动撤回**模态声明，恢复 DSH 原生准入门槛。于是谎言只在路由兜底存在时存活，失效时系统回到今天的行为，不会出现"图被发给文本端点"。

### 8.5 工程护栏（把契约锁进 CI）

1. **契约测试扩展**：现有 28 项测试 + stub 体系（dsh-session-stub 等）上，新增准入流程 stub、pre-step→request 时序 stub、模态解析 stub；每个 B 级触点一条"形状陌生→安全透传"测试。
2. **编译产物禁用模式守卫**（沿用 v0.8.4 的 session.append 守卫先例）：禁止 require('@deepseek-ai/dsh-agent-loop…') 等内部模块 import；禁止对 llm 服务方法赋值（猴补丁模式 resolveModelInfo = 直接 fail build）。
3. **升级金丝雀脚本**（scripts/compat-canary.mjs，本研究方法的固化）：解包本机 app.asar → grep 锚点清单（瀑布名单、payload 形状、MODEL_DOES_NOT_SUPPORT_IMAGES、resolveModelInfo 签名、conversation 发送流锚点、pi-ai input 字段）→ 输出全绿/黄/红报告。DSH 升级后先跑金丝雀：全绿→功能自动恢复全量；黄→按 8.1 矩阵降级；红→插件静默。
4. **可见性**：卡片常驻"兼容模式"指示（全功能 / 已降级到策略② / 仅手动模式），配合现有 switches.log。

### 8.6 残余风险（诚实清单）

- C 级钩子在 DSH 客户端重构时可能每版都要重新适配——这是选择"全自动体验"的机会成本；若完全不可接受，可只用策略②上线（零客户端钩子，代价是模态声明联锁需格外谨慎）。
- DSH 若未来原生实现"按输入自动路由"（rc 期功能活跃演进中），与本插件可能出现语义重叠——金丝雀锚点应包含其原生行为检测，检测到即让位并提示用户。
- 图片相关契约年轻（rc 期）：准入检查措辞/位置、pi-ai 模态字段、投影占位符都可能变；好在这些只影响"绕门槛的方式"，不影响插件主体（failover）。

## 九、按业务适配度自动切换（着陆页案例，2026-11-01 补充研究）

**结论：可行，且执行机制与 §四 完全复用（同一个 prepend 的 agent/request 监听器扩展决策函数）。新增的只是"信号→决策"层。** 关键认知：业务适配度不是一个新机制，而是三层信号的组合决策：

### 9.1 三层信号（按确定性递减）

| 层 | 信号 | 判定方式 | 可观测点（证据） |
|---|---|---|---|
| L0 输入模态 | 消息/工具结果含图片块 | 确定性递归检查 | agent/pre-step 的 messages（§三） |
| L1 工具轨迹 | 图片/视频工具被调用、看图审查阶段 | 事件流实时观测 | ctx.on("session/event")：dsh-session 是事件源服务，每个 append 事件都发布（L1575）；agent-loop 自己就用它做工具恢复（L976）——插件同样可订阅 tool/call 事件按 agent 记账 |
| L2 任务语义 | "着陆页/复杂逻辑/文案/重构" 等任务类别 | 分类器 | 三档实现：关键词规则（零成本可配置）→ flash 轻量分类（每用户轮一次，约 0.5-1s，仅规则未命中时）→ 主模型自声明（污染输出，弃用） |

### 9.2 着陆页案例解构（重要澄清）

"着陆页需要图片视频素材 → 切 5.3flash"需要拆开看——**素材"生成"与素材"理解"是两条路径**：

1. **生成路径 = 工具能力，不是 LLM 路由问题**。生态先例：dsh-connect-workbuddy 的 imageToolEnabled / imageModelIds / videoToolEnabled 配置——图片/视频生成作为工具暴露，**工具内部选择生成模型**，编排 LLM 用哪个都行。让 5.3 编排生成工具完全不损失能力；flash 参与的价值在"看参考图定风格 / 审查生成结果"——这本质是 L0 视觉输入路由（§四已覆盖）。
2. **理解路径 = 已研究的输入类型路由**：用户贴参考截图、工具返回预览图 → L0/L1 触发 → 该步路由 flash。
3. **复杂逻辑/布局代码 → 默认 5.3**（L1 无图信号时自动回落）。

即推荐编排走查：用户"做个着陆页" → L2 判为素材密集型（但规划/骨架步仍 5.3）→ 模型调生成工具（工具内用生成模型，无需切换）→ 参考图/预览图出现 → L0/L1 路由 flash 看图 → 回到 JS/响应式逻辑 → 回 5.3。每次实际模型都落在 request/header（既有能力，failover 已验证）。

### 9.3 防抖与安全边界

- **默认安全侧**：L2 分类不确定 → 保持默认模型（编码步被误切 flash 是最贵错误）。
- **滞回/相位粘住**：同一任务相位内不频繁切换（最少 N 步粘住；相位边界 = 用户新消息或工具阶段变化），防止代码风格随模型切换漂移。
- **分类可审计**：每次 L2 判定落 switches.log（类别、依据、命中规则），错判可回溯。
- **更轻的第一级适配**：agent/request 本就可返回 reasoningEffort（LlmCallConfig 字段；pi-ai reasoningInfo L1806 读取模型声明的思考档位）——"复杂逻辑→高思考档 / 简单文案→低档"可以先于"换模型"生效，前提是 GLM 端点模型声明了 reasoning 档位。
- **与原生 preset 的关系**：preset 只绑工具+指令，不绑模型（session-controller createSession 用全局默认模型 + preset 组装）——任务级模型路由目前是 DSH 的真空区，正是本功能的位置。

### 9.4 分期建议（在 §七 基础上追加）

- M1：L0 + L1（全确定性，零误判风险）——即 §四 方案 A 加上"工具轨迹反应式路由"
- M2：L2 规则集（着陆页/营销页/海报/文案等头部场景的关键词路由表，GUI 可编辑）
- M3：L2 flash 分类器（规则未命中时兜底，带缓存与跳过策略）

## 附录：关键源码位置（本机 DSH Desktop 0.2.1-rc.5，app.asar 解包）

- 准入检查：`dsh-api-session-controller/lib/index.js` L937-941；选择链 L273-313；selectModel L793-813；serializeImageAdmission L341-345
- Agent Loop：`dsh-agent-loop/lib/index.js` pre-step L905-925；消息落盘 L1070-1077；agent/request L1191-1197；request-error L1136-1146
- 事件融合 agent：`dsh-agent/lib/index.js` L243-271
- LLM 图片策略：`dsh-llm/lib/index.js` contentHasImage L594；投影门 L2337；textOnlyImageText L554-559；公开 API L2111/L2174/L2220/L2393
- 子代理检查：`dsh-subagent/lib/index.js` L2242、manager L1284
- 客户端发送流：`dsh-client-ui-conversation/lib/client.js` L4700-4737；错误文案 L18613
- 模态元数据：`dsh-llm-pi-ai/lib/index.js` L1897-1924；`dsh-client-ui-settings-models/lib/client.js` L251、L868
- 本插件已验证机制：`DESIGN.md`（prepend 抢最外层、volatile 配置热更、inFlight 按 agent 键、request-error 换号闭环）
