# DSH 实现取证笔记：自动模型路由 §六未决问题逐项查证

> 研究员：impl-design（源码取证）。基线：本机 DSH Desktop 0.2.1-rc.5，源码取自
> /tmp/dsh-extract2/dsh/node_modules/@deepseek-ai/&lt;pkg&gt;/lib/（app.asar 解包）。
> 上游文档：RESEARCH-AUTO-MODEL-SWITCH.md §四（方案A/B/策略①②③）、§六（未决问题）、§八（兼容性）、§九（业务路由）。
> 方法：纯静态源码取证，无运行时注入实验；行号均为解包产物实测行号。
> 状态标注：✅ 已查证到可动手；⚠️ 已查证但含实现陷阱；❓ 静态查不了（明说）。

---

## 1. 策略①客户端钩子的最稳挂点 ✅

### 结论

**最稳挂点不是"包裹 conversation 的发送函数"，而是包裹 remote.session 命名空间服务上的 prompt 方法**（可选再包 remote.subagents.prompt）。它是全部 UI 发送的唯一 RPC 漏斗点；本插件客户端**已经注入** remote.session（src/client.tsx L716），零新增注入声明。比它更靠上的每层（conversation.sendSession、客户端 Session.prompt）都是更大的包裹面；比它更靠下的（connection.rpc.call）会误伤所有 RPC。事件观测+补偿**单独不可行**（准入失败不广播、拿不到原始 content 重试），但可与包裹结合成"失败补偿模式"，优于"发送前预选"。

### 证据链

**(a) remote face 的构造真相**（dsh-api-gateway/lib/types/client/index.js）：
- ClientRemoteService extends Service，super(ctx, "remote") —— remote 是 cordis 服务。
- 每个命名空间是**独立的 cordis 服务** remote.&lt;ns&gt;：createNamespace 内 new RemoteNamespaceService(ctx, remoteServiceKey(name))，remoteServiceKey(name) = "remote." + name。
- 方法安装：RemoteNamespaceService.install 用 Object.defineProperty(this, method, { configurable: true, enumerable: true, get }) 挂在服务实例上；getter 每次返回新闭包 (...args) =&gt; this.invokeRemote(direct, scoped, callerCtx, args)。**无 Proxy 参与方法查找**（文件头注释明示）。
- 卸载：remove() 用 Reflect.deleteProperty(this, method)；重挂再 define。→ 插件重定义的包裹会被 unmount/remount 冲掉，需要指纹自检 + 自动重装（§8.4 已有该设计，方向正确）。

**(b) 发送漏斗**（全部汇聚到 remote.session.prompt）：
- dsh-client-ui-conversation/lib/client.js：
  - ConversationController.send(text) L4664-4670 → scopedSession("send").prompt([text块], "queue")；
  - sendSession(session, text, attachmentIds, mode, signal) L4685-4740：组 content（UI 局部图片块 L4694-4712 为 {type:"image", value:{previewUrl,…}}；序列化 L4706-4712 → {type:"image", mediaType, data(base64), name?}）→ beginSubmission L4717 → session.prompt(content, mode, signal, requestId) L4737。
- dsh-api-session-controller/lib/types/client/sessions/session.js（客户端对象层 Session）：prompt L173-229：**普通会话** L186-192 → this.remote.session.prompt({requestId, sessionId, mode, content, clientTimeZone}, signal)；**子代理续聊** L204-213 → this.remote.subagents.prompt({requestId, parentSessionId, childSessionId, mode:"continuable", delivery, content, clientTimeZone}, signal)；文件块在子代理路径直接拒绝（L194-198）。
- this.remote 是共享单例引用：session-controller client apply L4262-4265（const remotes = ctx.remote）→ ClientSessions 构造 L3811-3813 → SessionManager L3116（new Session(sessionId, this.remote, …)）。所有 Session 持同一 remote 服务对象，且 this.remote.session.prompt 是**调用时属性查找** → 对服务实例的一次包裹全局生效。

**(c) 备选锚点逐一排除**：
- 包 sendSession（conversation 服务实例方法）：方法非 getter、实例字段，包裹=覆盖实例属性；conversation 包 2 万行 UI 编排层，churn 大。劣于 remote face（后者是生成代码的稳定安装模式）。
- store 层：无官方"发送前"store 钩子。InputHub defaultSink 是闭包内构造（conversation client L15843、L15939-15942），非扩展点；draftAttachments 是普通 Map（L4629），无订阅通知。
- 事件观测+补偿（单独）：准入失败只作为 RPC 结果返回调用方（session-controller prompt L958-961 throw），客户端对象层写进 session.promptError（session.js L215-220），**不广播任何事件**；不包裹就拿不到原始 content 做自动重试。

**(d) 推荐实现形态——包裹 + 失败补偿**（比"发送前预选"更稳）：
包裹 prompt 后不改 happy path；当返回 ok:false 且 error.code === "session/attachment-invalid" 且 (error.details ?? {}).reason === "MODEL_DOES_NOT_SUPPORT_IMAGES"（宿主抛点 session-controller L937-941）→ 调 remote.session.selectModel(vision) → **用原参数重试一次 prompt（换新 requestId）** → 成功后 selectModel(原选择) 恢复。时序安全由宿主保证：selectModel 与图片准入共用每 agent 的 serializeImageAdmission 串行链（L341-345；selectModel L795、prompt L965），补偿的 selectModel 必然先于重试的准入。requestId 幂等去重见 L927 hasPromptRequest——**重试必须换新 id**，否则被当作重复请求吞掉。

**(e) selectModel 的两个必须知道的语义**（session-controller L793-821）：
- 副作用：selectForNextRequest（L312-315）追加 model/selection 会话事件 + 设 pending；**且 L809 agentDefaultModel.saveSelection(selected) 后台把该选择持久化为全局默认模型配置**（dsh-agent-default-model/lib/index.js L53-66，经 configEditor.edit 写 profile）。→ 策略①每张图至少两次全局默认写盘（切 flash + 切回）；失败补偿模式只在失败时发生。恢复步骤不能省，否则全局默认停在 flash。
- pending 消费：request/header 事件三字段（provider/model/reasoningEffort）**全匹配**才 consume 清除（L296-299 consume；触发点 L2997-3000）。若插件 agent/request 把带图步路由到与 pending 相同的 flash，自然消费；若路由到别处，pending 留存，下一次准入仍读 flash（对"下一张图免再次补偿"反而有利，但要知道这个状态存在）。

### 对实施方案的影响

- M1 策略①按"包 remote.session.prompt + 失败补偿重试"实现，C 级触点从"每次发送前置改模型"缩小为"仅准入失败时介入"，写盘副作用和时序风险同步缩小。
- 包裹自检：安装后立即调用一次探针（读 getter 判断是否仍指向自己）；HMR/命名空间 remount 后重装（§8.4 指纹方案照抄）。
- 子代理 UI 续聊（带图）需同款包裹 remote.subagents.prompt（查证6 的检查同样会拒）。

---

## 2. agent/pre-step 的 messages 精确形状 ✅

### 结论

payload = { messages: claimed, turn, step, signal }；claimed 是本步**新认领的收件箱消息**（next-step 全部 + 1 条 next-turn），**不含** runtime-context 消息（那是瀑布下游默认返回值追加的，以 source.kind === "runtime-context" 自标识）。图片块在会话内是 { type: "image", attachment: ref }（ref 含 sha256/尺寸/媒体类型），**块层没有 source.kind 字段**——source 在消息层。消息对象 deepFrozen，改写必须重建。

### 证据链

- preStep（dsh-agent-loop/lib/index.js L902-927）：claimed = this.inbox.claim(target, position.turn) L906；瀑布 payload L909-913；下游默认返回 L913-919：messages: context === undefined ? claimed : [...claimed, context] —— **runtime-context 只出现在返回值，不在入参 payload**。
- claim（L103-111）：先全部 next-step（steer/inject 落这里），再取 1 条 next-turn（followup 落这里）。放置规则见 ReactLoopAgent L806-814：followup → next-turn、steer → next-step、inject → next-step。
- 消息形状（dsh-llm/lib/types/message.js L34-64 createMessage/createUserMessage）：{ id: brandedUUID, role: "user", content: Block[], source }，经 deepFreeze(structuredClone(...)) —— **不可变**；方案B 替换图片块必须构造全新消息。
- source 分类法（dsh-api-session-controller/lib/typert.host.js MessageSourceMap 声明）：
  - 普通/steer 用户消息：{ kind: "user" }；RPC 来源：{ kind: "user", rpcId, clientTimeZone?, principal? } —— **kind 仍是 "user"**，steer 与 queue 在消息层**无任何可区分标记**（区分只在 inbox 放置，pre-step 时已丢失）。对"本步带图"检测无影响（图在 content 块里，与来源无关）。
  - runtime-context：{ kind: "runtime-context" } &amp; ContextFormed（agent-loop L218 SOURCE = "runtime-context"；构造 L338-348 {kind:"runtime-context", form:"snapshot", sections}，内容 [{type:"text", text: 快照}]）。
- 图片块两种形态：
  - RPC wire（prompt 入参）：{type:"image", mediaType, data: base64, name?}（conversation client L4706-4712 encodeImage）。
  - 会话内/认领到的：{type:"image", attachment: ref} —— 宿主 attachments.admitPromptContent（dsh-attachment/lib/index.js L242-265）把上传换发为持久 ref。ref 字段（dsh-attachment-local/lib/index.js L334-347）：attachmentId: "sha256:&lt;64hex&gt;"、mediaType、width、height、bytes（归一化后），另带原始 width/height。文件块：{type:"file", attachment: ref}。
- 落盘语义（agent-loop L1066-1073）：瀑布返回的 messages 里 source.kind === "runtime-context" 的特判去重，其余逐条 session.append("user/message", message, {surfaceOp:"append"}) —— pre-step 改写会真实落盘（方案B 已知代价，此处补齐行号）。
- aborted/唤醒边界：send(message, target, wakeup) 在 abort 后唤醒会把 next-step 改道 next-turn（L800-804）——形状不变；preStep 在非 running 相位直接抛错（L904），signal abort 后 throwIfAborted（L908/921）——**pre-step 标记与 agent/request 之间的状态传递在 abort 路径下自然作废**（下一步重新走 pre-step），插件的 pendingImage 标记应每次 pre-step 刷新而非累积。

### 对实施方案的影响

- 方案A 的 hasImageBlock 判定：对 payload.messages 逐消息查 content 数组里 block.type === "image" 即可覆盖"用户贴图"步骤；**read_image 工具结果图片不在 pre-step messages 里**（工具结果直接落 session log，见查证3），必须用 session/event 的 tool/result 观测补 L1 信号——§9.1 的 L0/L1 分层在实现上就是这个分工。
- 方案B 替换图片块：新建消息（原对象 deepFreeze 不可改；用 createUserMessage 新 id，宿主按新消息落盘）。
- steer 消息无需特判：与普通用户消息同形；真正要滤的是 next() 返回值尾部的 runtime-context 消息（source.kind === "runtime-context"）。

---

## 3. session/event 事件 payload 形状 ✅

### 结论

信封 {type, seq, time, data, sourceEventSeqs?, surfaceOp?}；监听签名 (session, event)，**按第一个参数 session.id 键控**（与 agent 瀑布 payload.agent.session.id 同一 id 空间）；session/event 是与 agent/* 不同的总线，事件里**没有** agent 字段。tool/call 带 {turn, step, callId, name, arguments}；tool/result 的图片在 message.content；request/header 带 {header:{config,…}, reason, startsSeries?}。

### 证据链

- 信封与发布（dsh-session/lib/index.js）：append L1517-1537 构造 deepFrozen 事件（seq=log 长度、time=Date.now()、data=JSON 快照）；commit L1579-1599 同步通知 session/event 监听器，**每监听器隔离**（一个抛错不影响其他）——插件监听器异常不会污染宿主。
- tool/call（dsh-agent-loop L681-688）：data = {turn, step, callId: block.id, name: block.name, arguments: block.arguments} —— name/arguments 就位；**不带 agent 字段**，键控用 session.id。
- tool/result（L691-706）：data = {turn, step, message: {callId, content, isError}, error?, meta?}，surfaceOp append + sourceEventSeqs 引用其 call。read_image 的结果图片块 = message.content 里的 {type:"image", attachment: ref} —— **L1 视觉信号的准确订阅点**。
- request/header（buildRequest L1214-1240）：data = {header: {config: {provider, model, reasoningEffort?, maxTokens?, temperature?}, tools?, adapterDefaults?}, reason: "initial"|"resume"|"change"|"series", startsSeries?}。轮内换模型即 reason:"change" 快照，宿主原生支持。
- agent 键的注入方式（dsh-agent L242-272 agentEvents）：emit/serial/waterfall 的 payload 经 fused() 合入 agent —— 只作用于 agent/* 事件线。session/event 要自己拿 session.id（session-controller L2997-3000 即范例：ctx.on("session/event", (session, event) =&gt; …) 且 ctx.agents.get(session.id) 可反查活 agent）。
- 订阅写法（插件侧）：ctx.on("session/event", (session, event) =&gt; { const key = String(session.id); … })；按 type 分派：tool/call（工具轨迹记账）、tool/result（含图检测→置 pendingImage）、request/header（实际模型落账，喂 §9 审计）。

### 对实施方案的影响

- L1 信号实现完全可行且零猜测：tool/call 的 name/arguments、tool/result 的 content、request/header 的 config 全部有确定形状。
- 按 agent 键统一：建议插件内部统一键函数 keyOf = String(session.id ?? agent.session.id)，与现有 inFlight 键对齐。
- 事件监听器要防重入（append 发布是同步的）：记账逻辑保持 O(1)、不抛错。

---

## 4. pi-ai 配置热加载真相 ✅（对策略②决定性）

### 结论

**走 remote.settings RPC 写 llm-pi-ai 命名空间 = 即时生效（下一次 LLM 调用/下一次 resolveModelInfo），无需重启、无需重载插件**；适配器**不重建也无需重建**（单例每操作重读 volatile 配置）。**直接编辑 YAML 文件不生效**（与 §六.8 的 40 秒实验一致）——生效链根本不经由文件监听，而是 settings 写入触发的 loader 重调和 volatile 提交。

### 证据链（完整因果链，每环实测行号）

1. **volatile 声明**：dsh-llm-pi-ai/lib/index.js L1083 —— Config = z.object({ providers: z.dict(profile).default({}).volatile() })，providers 整体 volatile。
2. **settings RPC 写入**（dsh-settings/lib/index.js）：update/mutate → write L470-536 → configEditor.edit(entry, fn) L508；write 强制**只能写 volatile 路径**（L505-507 无 volatile 字段直接拒；L513-521 非 volatile 深度校验）——providers 整体 volatile，改 providers.&lt;route&gt;.models[].input 合法。带 revision 乐观锁（L511，冲突抛 SettingsConflictError）。
3. **落盘+重调**（dsh-config-editor/lib/index.js edit L69-135）：waterfall internal/config 校验（pi-ai L2885-2891 监听做 assertServiceable——坏声明被拒，编辑回滚 L127-129）→ 原子写 YAML L123 → reconcileProfilePatches(root, patches, "dsh", [entryId]) L125。
4. **loader 更新**（dsh-app-boot/lib/index.js）：reconcileProfilePatches L3794-3796 → recompose → 根 Include entry.update({config:{…patches}}) L3853。
5. **volatile 提交**（@deepseek-ai/cordis-plugin-loader/lib/index.js Entry.update → _commitVolatile L395-427）：volatile-only diff 时就地更新 volatile ref（updateVolatile L415）并 emit("loader/volatile-update", paths) L422。
6. **pi-ai 响应**（dsh-llm-pi-ai）：监听 loader/volatile-update L2957-2965 → ensureRegistrationFacts（L2943-2956：注册事实 = provider/displayName/retryPolicy，L2823-2829 —— **模型表/模态变更不触发重注册，也不需要**）+ ensureDirectory。
7. **适配器即时读取**（关键）：PiAiAdapter 单例（apply L2904 只 new 一次）每操作调 current()（L1852-1860）：const profiles = this.config.profiles()，按 profiles **对象身份** memoize 快照——volatile ref 更新后 config.providers.get() 返回新对象 → profiles() 新身份（apply L2876-2883 同样按 raw 身份 memoize）→ resolveModelInfo/prepareCall/stream 的**下一次调用**即见新模态声明。类注释 L1826-1829 明示设计意图："a configuration change reaches the next request without a restart"。
8. **llm/adapters-updated 触发点**（dsh-llm/lib/index.js）：仅在适配器拓扑变化时 emit——registerAdapter L1842 附近与 replace L1892 附近，emit 实现 L1820-1831。模态声明变更**不触发**该事件（但无需触发；插件现有 autoDiscover 监听它已足够，路由集变化时 pi-ai 自己会 replace → 触发）。
9. **模态字段读取点**：pi-ai 模型声明 models[].input → 模态元数据（研究附录称 L1897-1924 区段）；请求期硬检查 streamWithSnapshot L1960-1961（model.input 含 image 否则 UNSUPPORTED_CONTENT）——策略②"善意的谎言"若配错，错误会从供应商层冒出，与 §8.4 联锁设计的预期一致。

### 对实施方案的影响

- **策略②可以做成"纯 settings 写入、即时生效"**：写 providers.&lt;默认路由&gt;.models[glm-5.3].input 增加 image → 立刻影响两处判定：会话准入 resolveModelInfo（session-controller L939，走适配器 fresh 快照）与 pi-ai 请求期检查。撤回 = 再写一次移除。
- 写入用 settings.mutate("llm-pi-ai", ops, revision)（路径 op 精准改数组元素）或 update（patch 合并）；GUI 卡片已有同款用法（client.tsx settings.mutate）。
- §六.8 的"必须内置这一探测"落地方案：写入后回调里立刻 llm.resolveModelInfo(provider, model)（宿主插件直调；客户端走 remote.llm.discoverModels）验证 inputModalities 已含 image，未生效则进入降级路径并告警。
- 注意：llm-pi-ai 的 settings 写入有 assertServiceable 前置校验（L2885-2891）——声明不存在的模型 id 会被拒，写入前应先 describe 现有 providers 结构。

---

## 5. agent/request 返回值携带 reasoningEffort ✅（含两个陷阱）

### 结论

**可以**。瀑布返回值即 proposedConfig，直接进入 llm.prepareCall → resolveCallWithInfo 校验/物化 reasoningEffort，随 request 对象（{...header.config, messages, …}）逐请求下发，pi-ai 侧请求级 effort 优先于 profile 默认。前提：目标模型声明了该档位，否则当次请求被 UNSUPPORTED_REASONING_EFFORT 拒绝。

### 证据链

- LlmCallConfig 字段面：dsh-llm/lib/index.js callConfigEquals L367-371 —— provider/model/**reasoningEffort**/temperature/maxTokens/stop；文件注释 L350-355 明示 "request waterfalls replace them"。
- 消费链1（loop 侧，dsh-agent-loop）：prepareRequest L1175-1212 —— 瀑布 L1191-1195 返回 proposedConfig → this.loopCtx.llm.prepareCall(proposedConfig, signal) L1201。
- 消费链2（llm 侧）：prepareCall L2220-2261 → resolveCallWithInfo L2182-2207：显式 effort 必须命中 modelInfo.reasoning.efforts（L2195 否则 LlmError UNSUPPORTED_REASONING_EFFORT）；未提供时物化 defaultEffort（L2193-2199）并记入 adapterDefaults.reasoningEffort=true（L2236-2239）。
- 消费链3（请求组装）：buildRequest L1281-1288 markAgentLoopRequest({...header.config, messages, toolHistory, tools, sessionId, signal}) —— effort 进入每次适配器调用；request/header 逐请求快照 L1226-1240（轮内改 effort = reason:"change"，原生支持）。
- 消费链4（pi-ai 侧）：streamWithSnapshot L1953 resolveReasoningLevel(model, options.reasoningEffort ?? profile.reasoning) —— **请求级优先**；L1984 profileOptions(profile, reasoning, apiKey) 注入 streamSimple。档位声明来源：profile 的 reasoningEfforts 映射（L571-606）与 pi-ai 目录元数据（reasoningInfo L1806-1815）。
- **陷阱1（seed 剥离）**：agent-loop requestProposal L716-722 —— 上一步 header 中由**适配器默认物化**的 reasoningEffort/maxTokens 会从 seed 剥掉；即瀑布入参（seed）可能"看不到"当前生效的 effort。语义上这是对的（换模型让目标模型解析自己的默认），但插件若想"读 seed 判断用户意图"要区分显式/默认。
- **陷阱2（插件现有 reroute 丢 effort）**：src/index.ts NEUTRAL_FIELDS = ["maxTokens","temperature"] —— 跨 provider 重路由时 reasoningEffort 被丢弃（回落目标模型默认）。场景路由上线时需决定：同 provider/model 透传 effort；跨模型默认不带（避免 UNSUPPORTED_REASONING_EFFORT 硬错误）；要带必须先 resolveModelInfo 验证档位存在（§9.3 "更轻的第一级适配"据此可用，前提是模型声明了档位）。

### 对实施方案的影响

- §9.3 的"复杂逻辑→高思考档"在 agent/request 返回值层面即刻可实现，无机制缺口。
- 场景路由的 reroute 函数要升级为按目标模型能力条件透传 effort（同模型带、跨模型丢或验证后带），并为此加一条契约测试（目标模型无档位时不得透传）。

---

## 6. subagent 路径能否被插件影响 ✅

### 结论

**能，且有三条通道**（两条已天然存在、一条官方配置）。图片准入检查（关卡2）读的是**子代理创建时固定的 agent.options**（不读瀑布路由），但该 options 的默认值 = **父代理最新 request/header 的 config**（即插件路由结果）——插件对父会话的路由会"继承"给子代理的准入判定；执行期子代理每请求同样走 agent/request 瀑布（插件现有 prepend 已覆盖）。

### 证据链（dsh-subagent/lib/index.js，除注明外）

- 检查点：assertImageCapable L2234-2243 —— 读 agent.options 的 provider/model → llm.resolveModelInfo → inputModalities 不含 image 抛 SubagentError MODEL_DOES_NOT_SUPPORT_IMAGES；触发于续聊提交 submitMaterialized L2200-2203（contentHasImage(content)）。注意 L2237：provider/model 任一为空直接放行（无 LLM 注册时也放行，L2238-2240）。
- 子代理模型决定链：resolveChildAgentOptions L315-331 = parentAgentOptionsForDelegation（L293-303：**parent.session.requestHeader()?.config 的 provider/model/reasoningEffort 覆盖父创建 options**）+ 请求级 override（requested，工具参数）。创建时快照进 descriptor（startLocal L1400-1411）；冷恢复从 descriptor 还原（coldResume L2167-2176）。
- 通道A（自动继承）：插件把父会话带图步路由到 flash → 该步 request/header 落 flash → 此后 spawn 的子代理初始模型 = flash → 关卡2 检查通过。反向陷阱：父在 flash 步后 spawn 文本任务子代理，初始也是 flash（成本/能力错配，M1 可接受、M2 可按 subagentDepth 修正路由）。
- 通道B（执行期瀑布）：子代理经 spawn-in-process 走 ctx.agents.create（同进程 ReactLoopAgent；manager startLocal L1391-1477），其 loop 的 dispatch 同样是 agentEvents → agent/request 瀑布。插件现有 prepend 监听器在根上下文注册，对子代理 agent 同样触发，inFlight 按 agent.session.id 天然分键。→ 执行期路由（含"子代理带图步走 flash"）不需要新机制，只需在路由决策里加 subagentDepth/带图条件。
- 通道C（官方配置）：dsh-tool-subagent/lib/index.js —— 部署开 modelSelectionSettings: true（Config L311-323）后，subagent 工具向编排模型暴露 provider/model/reasoning_effort 参数（L405-416）+ list_subagent_models 发现工具（L174-183），并有会话级 allowlist（subagent/model-selection-policy 事件，L268-292）。编排模型可自行为"看图"子代理选 flash —— **零插件代码**，但需要用户侧配置且 allowlist 要含 flash。

### 对实施方案的影响

- M1 不动子代理也可用：默认继承链（通道A）+ 执行期瀑布（通道B）已保证"父会话图片流不断"；关卡2 只在"子代理创建后用户向其续发图"且继承模型为文本模型时触发——由查证1 的 remote.subagents.prompt 包裹+补偿覆盖（补偿动作 selectModel 以 sessionId 寻址，子代理 session 有独立 agent，同样可用；但全局默认持久化副作用同样存在，恢复更重要）。
- M2 如需显式覆盖：优先文档化通道C（开 modelSelectionSettings + allowlist 放 flash），插件侧仅补"子代理带图步强制 flash"的路由规则（通道B 决策函数加分支），不改任何子代理内部结构。

---

## 未尽事项与诚实清单 ❓

1. **无运行时实验**：本笔记为静态取证。包裹 remote.session.prompt（getter 重定义）与失败补偿重试建议在 M0 spike 各跑一轮真机验证，重点：(i) HMR/命名空间 remount 后包裹是否存活；(ii) 补偿重试换新 requestId 后，客户端对象层 echo 呈现是否正常（首次失败的 echo 已 retire，重试需重新 beginSubmission 或接受无 echo 直接 RPC——spike 时确认 UI 行为）。
2. **pi-ai 图片请求编码细节**（§六.3，相邻项）：已定位 imageRequestTarget L1837-1845（按 profile 的 requestImagePixelBudget/maxBytes 投影）、请求期检查 L1960-1963、toPiContext 附件解析 L1971-1982（resolveImageAccess / readImageRequest 变体缓存 L1053-1067）；base64 vs URL 的最终 dispatch 在上游库 @earendil-works/pi-ai 内，未逐行追。GLM 端点真实接受度/尺寸限制需实测。
3. **会话日志/UI 对轮内切换的呈现**（§六.4）：request/header reason:"change" 机制已确认（查证3），轨迹页渲染友好度属 UI 主观项，静态取证下不了结论；建议 M1 用现有 failover 的真实日志人工过一眼。
4. **凭据/计费归因**（§六.7）：credentials/CredentialRef 体系与 profile.apiKeyEnv → credential 解析链已见（pi-ai L2892-2898），无新发现，维持原结论"直接可用，GUI 展示清楚即可"。

---

## 附录：本次取证关键锚点速查（0.2.1-rc.5 实测行号）

| 主题 | 文件（相对 /tmp/dsh-extract2/dsh/node_modules/@deepseek-ai/） | 行号 |
|---|---|---|
| remote face 构造/命名空间服务/方法安装 | dsh-api-gateway/lib/types/client/index.js | ClientRemoteService、RemoteNamespaceService.install（configurable getter）、remove（deleteProperty） |
| 发送漏斗 conversation→Session.prompt→RPC | dsh-client-ui-conversation/lib/client.js L4685-4740；dsh-api-session-controller/lib/types/client/sessions/session.js L173-229 | prompt RPC L186-192；subagents RPC L204-213 |
| 准入检查/selectModel/串行链/pending 消费 | dsh-api-session-controller/lib/index.js | L925-966、L793-821、L341-345、L296-315、L2997-3000 |
| selectModel 持久化全局默认 | dsh-agent-default-model/lib/index.js | L53-66 |
| pre-step payload/claim/落盘 | dsh-agent-loop/lib/index.js | L902-927、L103-111、L806-814、L1066-1073 |
| 消息构造与冻结 | dsh-llm/lib/types/message.js | L34-64 |
| source 分类法（含 user-rpc、runtime-context） | dsh-api-session-controller/lib/typert.host.js | MessageSourceMap 声明 |
| 图片块 wire/持久形态 | dsh-client-ui-conversation L4706-4712；dsh-attachment/lib/index.js L242-265；dsh-attachment-local/lib/index.js L334-347 | — |
| session/event 信封与发布 | dsh-session/lib/index.js | L1517-1537、L1579-1599 |
| tool/call、tool/result、request/header 事件 | dsh-agent-loop/lib/index.js | L681-688、L691-706、L1214-1240 |
| agent/* 事件融合 agent 键 | dsh-agent/lib/index.js | L242-272 |
| pi-ai volatile/热加载链 | dsh-llm-pi-ai L1083、L2860-2965、L1852-1860；dsh-settings L470-536；dsh-config-editor L69-135；dsh-app-boot L3794-3853；cordis-plugin-loader L395-427 | — |
| adapters-updated emit | dsh-llm/lib/index.js | L1820-1831、L1842、L1892 |
| LlmCallConfig/reasoningEffort 消费 | dsh-llm/lib/index.js L367-371、L2182-2207、L2220-2261；dsh-agent-loop L1175-1212、L716-722；dsh-llm-pi-ai L1953、L1984 | — |
| subagent 检查/模型继承/工具参数 | dsh-subagent/lib/index.js L2234-2243、L293-331、L1400-1411；dsh-tool-subagent/lib/index.js L311-323、L405-416、L174-183、L268-292 | — |
