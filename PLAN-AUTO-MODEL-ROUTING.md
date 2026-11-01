# dsh-model-failover 自动模型路由 —— 最终实施方案

> 版本：v1.0（2026-11-01）｜ 状态：**待评审，未开发**
> 输入：[RESEARCH-AUTO-MODEL-SWITCH.md](RESEARCH-AUTO-MODEL-SWITCH.md)（可行性研究 §一-§九）＋ 研究团队三份取证笔记：
> [router-practices.md](research/team/router-practices.md)（业界路由实践）、[glm-capabilities.md](research/team/glm-capabilities.md)（GLM 生态硬事实）、[dsh-impl-notes.md](research/team/dsh-impl-notes.md)（DSH 0.2.1-rc.5 源码取证）
> 本文档是唯一实施依据；与 RESEARCH 冲突处以本文档为准（研究期结论已被团队取证修正的共 5 处，见 §1.3）。

---

## 0. 摘要（一页决策）

**做什么**：在现有 failover 插件上加"自动模型路由"——按输入模态与业务适配度自动在 glm-5.3（默认/编码）与 glm-5.3-flash（视觉/轻量）间切换，复杂度适配优先用 reasoning_effort 档位而非换模型。

**怎么做**：三层架构——信号层（L0 模态检测 / L1 工具轨迹事件 / L2 规则+分类器）→ 决策层（优先级裁决+相位粘滞+fail-safe）→ 执行层（单一 prepend agent/request 监听器 + 客户端失败补偿 + 可选转写管线）。全部复用已验证的公开插件契约，C 级触点（客户端包裹）缩小为"仅准入失败时介入"。

**关键验证结论**（全部有源码/文档证据）：
- 路由执行机制：本插件已在生产验证（prepend agent/request 无条件改路由）
- 准入门槛绕行：客户端"失败补偿"模式（wrap remote.session.prompt，捕获 MODEL_DOES_NOT_SUPPORT_IMAGES → selectModel → 新 requestId 重试 → 恢复）
- 策略②降级：settings RPC 写 llm-pi-ai 模态声明**零重启即时生效**（volatile 链已取证）
- 生成类素材：**不切换对话模型**（GLM 生成 API 不走套餐额度，业界一律工具内选模型）
- 业界共识：无一款编码 agent 以全自动路由为默认 → 我们用"保守/均衡/激进"三档旋钮 + 首次切换"询问并记住"

**分期**：M0 spike（2-3 天，3 项硬验证）→ M1 确定性路由 L0+L1 → M2 转写+降级联锁 → M3 规则路由+GUI → M4 分类器+子代理。每期有可测试验收标准。

---

## 1. 需求、范围与结论

### 1.1 三个原始问题的最终答案

| 问题 | 答案 | 一句话依据 |
|---|---|---|
| ① 按输入类型自动切换（截图→flash→回切） | **可行，M0+M1 交付** | 准入检查可经失败补偿绕过；每步路由改写已被 failover 插件生产验证 |
| ② 按业务适配度切换（着陆页→flash，复杂逻辑→5.3） | **可行但须拆解**：素材"生成"走工具内模型（不切对话模型，GLM 生成 API 不走套餐额度）；"看图"走 L0 路由；任务语义走 L2 规则/分类器（M3/M4） | 业界无一通过切换对话模型获得生成能力；模态路由一律是候选过滤 |
| ③ 不产生强依赖、升级不回归 | **可保证**：A/B/C 三级触点分级 + fail-closed to stock + 金丝雀锚点 + 编译产物守卫 | 核心瀑布跨 0.0.x→0.2.1 五个版本形状未变（实测 diff） |

### 1.2 明确不做（Non-goals）

- 不做全自动语义路由为**默认**行为（业界无先例，分类误判代价高）——默认档位是"保守"（仅确定性路由）
- 不为图片/视频**生成**切换对话模型（生成走工具+标准 key，见 glm-capabilities §4）
- 不做代理进程/外部路由服务（与既有架构决策一致，DESIGN §1.2）
- 不修改宿主任何文件（含 asar）；不猴补任何服务方法（编译产物守卫强制）

### 1.3 相对研究期的 5 处设计修正（团队取证结果）

1. **策略①从"发送前预选"改为"失败补偿"**：wrap remote.session.prompt 不改 happy path，仅在 MODEL_DOES_NOT_SUPPORT_IMAGES 时 selectModel(vision) → 换**新 requestId** 重试 → selectModel 恢复。介入面、写盘副作用、时序风险同步缩小（dsh-impl-notes 查证1）
2. **策略②确认零重启**：settings RPC 写 llm-pi-ai 走 volatile→configEditor→loader/volatile-update→适配器逐操作重读 profiles，**即时生效**；直接改 YAML 文件无效（已实测+源码双重证实）
3. **reroute 必须保留 reasoningEffort**：现有 NEUTRAL_FIELDS 不含 effort，跨模型改写会丢档位；同时这也是"复杂度适配第一级"的载体（GLM 5.3 系列支持 low/high/max，强制思考不可关）
4. **read_image 工具图片不在 pre-step messages**（直接落 session log）→ 看图步路由必须靠 L1 session/event 观测 tool/result，L0/L1 分工由此定形（dsh-impl-notes 查证2/3）
5. **转写（方案B）须保留 reasoning_content**（clear_thinking:false 语义）且套餐自带"视觉理解 MCP（flash 内核）"为官方同构先例（glm-capabilities §3/§5）

---

## 2. 事实基础（引用索引）

### 2.1 GLM 生态（glm-capabilities.md）
- 套餐内仅 glm-5.3（纯文本）+ glm-5.3-flash（原生多模态：图/视频/文件，1M 上下文，积分系数 1/3=额度×3）；glm-4.6v **不在套餐**（备选需标准 key 或免费 4.6v-flash）
- 图片输入：单张 ≤5M、≤6000×6000、jpg/png/jpeg、50 张/请求、Base64 Data URL 官方支持；视频 URL-only ≤200M
- reasoning_effort low/high/max 可用（none/minimal 被端点容错映射为 low，不炸）
- 生成模型（GLM-Image/CogView-4/CogVideoX-3）独立端点按次计费，**不走套餐额度**【推断级证据链：套餐模型清单+端点协议表+错误码 1311 交叉，非官方明文；M0 真机复核】（glm-capabilities §4）
- 错误分类锚点：429 + error.code（**1302** 账户限流 / **1305** 平台过载 / **1308·1310** 周期额度耗尽（含 next_flush_time）/ **1309** 套餐过期 / **1311** 模型不在套餐 / **1113** 欠费）
- 套餐耗尽不透支余额 → 换号 failover 是刚需；**合规灰区**：DSH 不在官方指定工具清单，文档须免责声明

### 2.2 业界实践（router-practices.md，10 条借鉴全文见该文档 §五）
- 无一编码 agent 以全自动路由为默认；Claude Code=手动+三类边界自动（相位切换/分类器回退会话粘住/过载回退仅当前轮）；Cursor=每请求 ML 分类器仅 Teams 且隐藏底层模型；Copilot Fusion 沿缓存边界路由防抖
- 专用路由器共识：确定性信号优先→分类器兜底→阈值裁决→优雅降级；绝不为路由增加显式前置 LLM 往返
- 防翻转四对策：自然边界切换、相位粘住、轮级重试主模型、（可选取）隐藏底层模型
- 路由层失效=退回原生行为，永不放大故障（与我们的 fail-closed 同构）

### 2.3 DSH 实现细节（dsh-impl-notes.md，6 项全取证）
- 客户端漏斗：所有 UI 发送汇聚 remote.session.prompt（生成代码的 getter 安装，configurable，remount 会冲掉包裹→需指纹自检重装）；子代理续聊走 remote.subagents.prompt（文件块直接拒）
- selectModel 副作用：持久化**全局默认**（每张图至少两次写盘）+ pending 三字段全匹配才消费
- pre-step：{messages, turn, step, signal}；图片块 {type:'image', attachment:{attachmentId:'sha256:…',mediaType,width,height,bytes}}；消息 deepFrozen，改写必须重建；steer 无标记（不影响检测）
- session/event：信封 {type,seq,time,data}，(session,event) 签名按 session.id 键控；tool/call {turn,step,callId,name,arguments}；read_image 图片在 tool/result 的 message.content；监听器异常相互隔离
- pi-ai 热加载：RPC 写即时生效（链路见查证4），文件写无效；写入受 assertServiceable 校验
- subagent 三通道可影响：父 request/header 继承 + 同进程瀑布 + 官方 modelSelectionSettings

---

## 3. 总体架构

```
┌────────────────────── 信号层（采集器，全部公开契约） ──────────────────────┐
│ L0 模态检测   agent/pre-step → payload.messages[].content[].type==='image' │
│              （用户贴图步；消息 deepFrozen，只读不改——M1）                  │
│ L1 工具轨迹   ctx.on('session/event') 按 session.id 键控：                 │
│              tool/result 含图片块 → 标记"看图相位"；tool/call 命中生成类    │
│              工具名单 → 标记"素材相位"（M1）；request/header 观测实际路由    │
│ L2 任务语义   规则表（关键词→场景，GUI 可编辑，M3）→ flash 分类器兜底       │
│              （规则未命中且档位=激进才调用；结果按用户轮缓存，M4）           │
└────────────────────────────────┬───────────────────────────────────────────┘
                                 ▼
┌────────────────── 决策层（纯函数，可单测） ────────────────────────────────┐
│ 优先级 L0 > L1 > L2 ｜ 相位粘滞：判定只在自然边界刷新（新用户消息/工具阶段    │
│ 变化），同相位最少 N 步不切 ｜ fail-safe：不确定→默认模型 ｜                │
│ 复杂度适配第一级：reasoning_effort 档位（不换模型） ｜ 每次判定落审计日志    │
└────────────────────────────────┬───────────────────────────────────────────┘
                                 ▼
┌────────────────── 执行层 ─────────────────────────────────────────────────┐
│ ① 路由：prepend agent/request 单监听器（场景判定→改写路由→保留 effort）     │
│    与 failover 合流：场景改写后仍过"第一个健康条目"逻辑（vision 链只收      │
│    inputModalities 含 image 的条目）＋ GLM 429 业务码分类表               │
│ ② 准入：客户端失败补偿（wrap remote.session.prompt，仅 MODEL_DOES_NOT_     │
│    SUPPORT_IMAGES 时介入）→ 降级：策略② settings RPC 模态声明（即时生效）  │
│    + 路由监听失效自动撤回声明的 fail-closed 联锁                           │
│ ③ 转写（M2 可选）：pre-step 重建消息，图片块→flash 描述文本，保留           │
│    reasoning_content；全程回默认模型                                       │
└───────────────────────────────────────────────────────────────────────────┘
```

**用户可见面**：模式旋钮（保守=仅 L0/L1 ｜ 均衡=+L2 规则 ｜ 激进=+分类器）＋ 首次自动切换"询问并记住"＋ 每次切换的横幅/日志（类别+依据）。

---

## 4. 详细设计

### 4.1 信号层

**L0 模态检测（M1）**
- 监听 agent/pre-step：`const msgs = payload?.messages; if (!Array.isArray(msgs)) return next()`（形状陌生即透传）
- 判定：任一消息 content 含 type==='image' 块（含嵌套无需递归——pre-step 只有用户消息；工具图片在 L1）
- 状态：`pendingImage.set(agentKey, has)`，每次 pre-step **刷新**（abort 路径自然作废，不累积）

**L1 工具轨迹（M1）**
- ctx.on('session/event', (session, event))：按 session.id 键控；tool/result → 查 message.content 含 image 块 → 置"看图相位"（TTL=到下一个自然边界）；tool/call → name 命中可配置生成工具名单（默认含 image/video/cogview 字样）→ 置"素材相位"
- 事件监听器 try/catch 包裹（宿主保证监听器隔离，但我们仍自律）

**L2 规则+分类器（M3/M4）**
- 规则表：`rules: [{ pattern: '着陆页|营销页|landing', scene: 'asset-heavy' }, …]`，正则命中用户消息文本
- 分类器（激进档）：flash 一次调用，prompt 输出枚举 scene + confidence；confidence < 阈值 → 默认模型；结果缓存至轮结束；**绝不在路由关键路径上加第二次往返**（业界纪律）

### 4.2 决策层（纯函数 decide(signals) → Route）

- 输入：{ L0: hasImage, L1: phase, L2: scene?, currentRoute, stepInPhase, mode }
- 规则（按序）：
  1. L0=true 或 L1=看图相位 → vision 路由（flash 链第一个健康条目）
  2. L1=素材相位 且 mode≠保守 → vision（审查生成结果用）
  3. L2 命中 scene 且 mode=激进 → 该 scene 的路由表条目
  4. 其余 → default 路由（glm-5.3 链）
- 粘滞：switch 后同相位内 stepInPhase < N（默认 3）不再判 L2；相位边界=新用户消息或 L1 相位变化
- effort 适配（独立于换模型）：编码步默认 high；scene=文案类且激进档 → low（GLM 端点容错，不炸）
- 审计：每次**变更**写 switches.log {agent, from, to, reason: 'L0-image'|'L1-tool:image'|'L2-rule:xx'|'L2-classifier', via}
- **首次切换交互**（业界借鉴 #9）：首次自动切换弹一次性确认（记住/每次问/关闭），存入配置

### 4.3 执行层——路由监听器（M1 核心）

合并进现有 prepend agent/request 监听器，顺序固定：**场景判定 → 路由改写 →（请求后）错误分类 → failover**。关键升级：
- reroute 保留 reasoningEffort（NEUTRAL_FIELDS 加入）；effort 档位可由决策层覆盖
- vision 链构造：llm.resolveModelInfo(p, m).inputModalities 含 'image' 才入链（建链时过滤 + llm/adapters-updated 时刷新）
- 错误分类表新增 GLM 业务码：1302/1305→rate-limit；1308/1310/1113→quota（1308/1310 含 next_flush_time，可优化冷却时长）；1309/1311→other（不换号，报警告知）
- 判定失败/形状陌生 → 返回 next() 原值（fail-closed）

### 4.4 执行层——准入失败补偿（M1，替代原策略①）

- 包裹点：remote.session.prompt（插件 client 已注入该服务，零新增声明）；同样包裹 remote.subagents.prompt（子代理续聊带图路径）
- 逻辑：ok:false && code='session/attachment-invalid' && reason='MODEL_DOES_NOT_SUPPORT_IMAGES' →
  1. selectModel({provider: vision链首})（宿主 serializeImageAdmission 保证与重试准入串行）
  2. 以原参数重试 prompt，**换新 requestId**（旧 id 会被幂等去重吞掉）
  3. 成功后 selectModel(原选择) 恢复（防全局默认停在 flash）
- 自检：安装后探针验证包裹生效；getter 指纹变化（remount/HMR）→ 自动重装；重装失败 → 进入策略②并告警
- UX：补偿发生时横幅提示"已自动切换 flash 识别图片，完成后切回"

### 4.5 执行层——策略②降级与 fail-closed 联锁（M2）

- 客户端钩子不可用时：settings RPC 写 llm-pi-ai 命名空间，把默认模型的 input 模态声明为含 image（即时生效，零重启）→ 准入放行；图片步由路由监听器**强制**送 vision（默认模型实际永不收图）
- **联锁**：路由监听器每次 wire 时上报心跳（lastArmedAt 写配置）；客户端检测到心跳缺失/过期 → 自动撤回模态声明 → 恢复宿主原生门槛（最坏=回到今天的报错，绝不更坏）
- 声明撤销用 settings.mutate 精确 unset，不做全量覆盖

### 4.6 转写模式（M2 可选开关，visionMode: transcribe）

- pre-step 监听：新认领消息含图片块 → attachments.readImage(ref) → llm.stream(flash) 生成"编码代理视角"描述 → **重建消息**（deepFrozen 不可改）：保留原图片块 + 追加描述文本块（UI 不丢图）；后续步全走默认模型
- 转写调用保留 reasoning（clear_thinking:false 语义）；失败 → 退回路由模式（L0 路由）
- 收益：历史不再带图（token 一次性）、不触发图片卸载、文本模型永续可见图片信息
- 官方同构先例：套餐自带"视觉理解 MCP"（flash 内核）

### 4.7 配置模型（YAML，GUI 编辑）

```yaml
model-failover:
  routing:
    mode: balanced            # conservative | balanced | aggressive
    default:  { provider: zai-coding-cn,   model: glm-5.3 }
    vision:   { provider: zai-coding-cn,   model: glm-5.3-flash }
    effort:   { coding: high, light: low }   # reasoning_effort 档位
    stickySteps: 3             # 相位粘滞最小步数
    visionMode: route          # route | transcribe（M2）
    transcribePrompt: ''       # 空=内置默认（编码代理视角）
    rules: []                  # L2 规则表（M3）：[{pattern, scene, route}]
    firstSwitchAsk: ask        # ask | always | never（首次切换交互）
    imageTools: [image, video, cogview, draw, render]   # L1 生成工具名名单
```

### 4.8 子代理覆盖（M4，三通道已取证）

父会话 request/header 自动成为子代理初始模型（含路由结果）→ 主路径免费获得；带图子代理续聊由 4.4 的 subagents.prompt 包裹覆盖；深水区（modelSelectionSettings）留 M4 评估。

---

## 5. 实施分期与验收标准

### M0 spike（2-3 天，全部真机）
| # | 任务 | 验收 |
|---|---|---|
| 0.1 | 客户端包裹+失败补偿最小闭环（硬编码模型对） | 默认模型 5.3 时发截图：无报错、自动 flash 识别、横幅提示、结束后选择恢复；宿主无感知异常日志 |
| 0.2 | pre-step 标记 + agent/request 联动改路由 | 会话日志 request/header 显示带图步=flash、无图步=5.3；read_image 工具结果步同样被切（L1） |
| 0.3 | fail-closed 验收 | 移除路由监听器（禁用插件）后行为与未安装完全一致；拔包裹后仅回到原生报错 |
| 0.4 | settings RPC 热生效复核 | RPC 写 llm-pi-ai 模态后**不发版不重启**，准入放行（复现取证4） |

### M1 确定性路由（1 周）
- L0+L1 信号、决策层纯函数、单一 prepend 监听器、vision 链过滤、reroute 保 effort、GLM 错误码表、审计日志、首次切换询问
- 验收：截图→自动 flash→回切全链路；read_image 在 5.3 会话可用；flash 欠费时 vision 链按 1308/1113 换号；判定审计可查；28+ 既有测试全绿+新增契约测试

### M2 转写与联锁（1 周）
- transcribe 模式（含 reasoning 保留、失败退回）、策略②降级、心跳联锁自动撤回
- 验收：transcribe 开启后历史无图片块且默认模型能回答图片细节；禁用路由监听 → 模态声明 60s 内自动撤回 → 行为=原生

### M3 规则路由与 GUI（1 周）
- L2 规则表 + 卡片"场景路由"区 + 模式旋钮 + 粘滞/effort 可视化
- 验收："做个着陆页"（均衡档）→ 规划步 5.3 → 生成工具步不切（工具内模型）→ 审图步 flash → JS 步回 5.3，全程 request/header 可复盘

### M4 分类器与子代理（可选，1 周）
- 激进档 flash 分类器（缓存+置信度阈值）、subagents.prompt 包裹、用量统计扩展
- 验收：分类延迟 <1.5s/轮（仅规则未命中轮）；置信度低于阈值 100% 保持默认模型

---

## 6. 测试与守护

1. **契约测试**：pre-step/session-event/tool-result/图片块形状入 stub（取证形状为准）；决策层纯函数表驱动单测；"形状陌生→透传"每触点一条
2. **编译产物守卫**（沿用 v0.8.4 先例）：禁止 import @deepseek-ai 内部包、禁止对 llm/remote 服务方法赋值以外的猴补模式（白名单：remote.session.prompt/subagents.prompt 包裹，需带指纹自检代码标记）
3. **兼容金丝雀** scripts/compat-canary.mjs：asar 解包 grep 锚点（在 RESEARCH §8.5 清单上新增）：remote namespace getter 安装模式、MODEL_DOES_NOT_SUPPORT_IMAGES、serializeImageAdmission、hasPromptRequest 幂等、pi-ai volatile 重读链、llm-pi-ai settings schema（input 字段）
4. **升级回归流程**：DSH 升级 → 金丝雀 → 绿=全功能 / 黄=按触点矩阵降级 / 红=静默+卡片提示
5. **真机验收清单**：每期验收标准（§5）即真机脚本化清单

## 7. 风险登记册（更新版）

| 风险 | 等级 | 缓解 |
|---|---|---|
| 客户端包裹被 remount/HMR 冲掉 | 中 | 指纹自检+自动重装（§4.4）；降级策略② |
| **合规灰区**：DSH 不在 GLM 指定工具清单 | 中 | README/卡片免责声明明示"用户自担"；不改变现状（failover 同样适用） |
| 分类误判切错模型 | 中 | 默认保守档；置信度阈值；粘滞；审计可回溯 |
| 原生功能重叠（上游活跃，10-29 发 rc.5） | 低-中 | 金丝雀含原生路由检测；检测到即让位并提示 |
| selectModel 全局默认写盘副作用 | 低 | 补偿模式仅失败时触发+必恢复；审计记录 |
| 套餐积分耗尽不透支 | — | 既有 failover 换号刚需，错误码表已适配 |
| pi-ai 图片编码细节（上游库未逐行追） | 低 | M0 真机截图链路即覆盖验证 |

## 8. 文档与交付物索引
- 可行性研究：RESEARCH-AUTO-MODEL-SWITCH.md（§一-§九）
- 团队取证：research/team/{router-practices, glm-capabilities, dsh-impl-notes}.md
- 本方案：PLAN-AUTO-MODEL-ROUTING.md（实施唯一依据）
- 后续：M0 spike 报告 → 按 §5 逐期交付
