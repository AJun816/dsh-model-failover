# 业界模型路由与自动切换实践：对比分析（router-practices）

> 调研日期：2026-11-01 ｜ 研究员：router-research（team）
> 方法：本宿主 web_search 后端故障（DeepSeek 搜索端点 402），全部结论经 **web_fetch 直抓官方文档 / 论文 / GitHub 仓库**核实，每条附来源 URL；无法核实的点显式标注"未能核实"。
> 定位：与 [RESEARCH-AUTO-MODEL-SWITCH.md](../../RESEARCH-AUTO-MODEL-SWITCH.md) 互补——该文档回答"DSH 里怎么做"（§四候选方案、§八触点分级、§九三层信号），本文回答"**业界怎么做、哪些设计被反复验证**"，供最终实施方案引用，不重复其内容（交叉引用处以 §四/§八/§九 指代）。

---

## TL;DR：一页对照表

| 维度 | 业界主流做法 | 代表产品 | 对本项目的直接启示 |
|---|---|---|---|
| 编码 agent 的切换入口 | **手动为骨架**（模型选择器/配置文件），自动切换只出现在明确边界的场景（计划阶段、安全标记、过载） | Claude Code、Copilot、Codex | 全自动路由做成"可选叠加层"，默认行为保持 DSH 原生 |
| 自动切换的粒度 | 请求级（每 prompt 判定）+ **相位/边界粘住**防抖 | OpenRouter、Switchyard、Copilot Fusion | 佐证 §9.3 滞回设计：切点放在自然边界，不逐步重判 |
| 决策信号分层 | 确定性信号（模态/工具轨迹）优先、零成本；分类器只做兜底 | Switchyard stage→judge、semantic-router、OpenRouter | 直接佐证 L0/L1 先行、L2 规则→分类器分级的 M1-M3 分期 |
| 模态路由 | 模态是**候选过滤条件**，不是"切换对话模型"的动作 | OpenRouter、Portkey、semantic-router 多模态 | 建链时 `resolveModelInfo` 校验（§五）与业界一致 |
| 生成 vs 理解 | 生成走专用 API/工具内选模型；对话模型不因"要生成素材"而切换 | OpenRouter Image API、DSH workbuddy 先例（§9.2） | 佐证 §9.2 的"素材生成=工具能力"澄清 |
| 失败安全 | 路由基础设施故障时**优雅降级到默认模型集**，请求绝不因路由而失败 | OpenRouter Auto Router、Claude Code opusplan 排除即跳过 | 对应 §八 "fail-closed to stock"，属硬要求 |
| 可见性/可审计 | 切换必有通知与日志；可查路由原因（task_type 元数据） | Claude Code 转录通知、OpenRouter metadata、Cursor 底层模型可显 | switches.log 对齐业界；考虑暴露 task_type 类似物 |
| 延迟 | 判定要么毫秒级本地、要么 in-flight、要么零额外调用 | Portkey <1ms、semantic-router 毫秒、Switchyard stage 零调用 | L2 分类器只在规则未命中时触发（每用户轮一次，§9.1） |

---

## 一、编码 agent 产品：模型切换是手动的还是自动的？

### 1.1 Claude Code：手动为骨架 + 三类内建自动切换

**手动面（主体）**：`/model` 选择器（带价格标签）、`--model` 启动参数、`ANTHROPIC_MODEL` 环境变量、settings 的 `model` 键；模型用**别名**（`default`/`best`/`fable`/`sonnet`/`opus`/`haiku`/`sonnet[1m]`/`opus`[1m]`）指向"该 provider 推荐版本"，用完整模型名 pin 版本。对话中途可切换；切换会传导到"继承会话模型"的子代理（启动时解析）；resume 的会话保留存档时的模型。来源：[Model configuration — Claude Code Docs](https://code.claude.com/docs/en/model-config)（下称 CC-Model-Doc）。

**自动切换 #1：任务相位切换（opusplan）**。别名 `opusplan` = "Special mode that uses `opus` during plan mode, then switches to `sonnet` for execution"（CC-Model-Doc [别名表](https://code.claude.com/docs/en/model-config#model-aliases)）。这是编码 agent 内**最接近我们需求的原生实现**：按任务阶段（规划 vs 执行）自动换模型，且降级路径明确——当升级目标被企业 allowlist 排除时"uses the newest permitted version of the upgrade family… the upgrade is skipped and planning continues on the session's model"（升级失败不报错，继续用原模型）。

**自动切换 #2：内容分类器触发的会话级回退**。Fable/Opus 5.5/Sonnet 5.5/Opus 5 运行带安全分类器，命中网安/生物类别时自动改跑类别专用回退模型（如 Opus 5.5 网安→Opus 4.8）；**切换后在回退模型上粘住（session 级），用户需 `/model` 手动回切**；转录中显示通知；用户可用 `switchModelsOnFlag` 设为自动/每次询问(`Ask each time`)/关闭——"pauses at a flagged request… gives you two options: switch to the fallback model, or edit the prompt and retry"，且首次触发时交互式询问并记住选择（CC-Model-Doc [Automatic model fallback](https://code.claude.com/docs/en/model-config#automatic-model-fallback)）。effort 档位跨回退保持不变。

**自动切换 #3：可用性回退链（Fallback model chains）**。主模型过载/不可用/非重试性服务端错误时按序尝试 `--fallback-model sonnet,haiku` 或 settings `fallbackModel` 数组（去重后上限 3 个）；**鉴权/计费/限流/请求超限/传输错误不触发切换**（走正常重试与报错）；切换**只持续当前轮**——"The switch lasts for the current turn only, so your next message tries the primary model first again"（CC-Model-Doc [Fallback model chains](https://code.claude.com/docs/en/model-config#fallback-model-chains)）。

**辅助小模型解耦**：①权限 Auto mode 用独立"默认分类器模型"做判定，被 allowlist 排除时退回会话模型（CC-Model-Doc）；②官方成本指南建议"简单子代理任务在子代理配置里指定 `model: haiku`"（[Costs — Claude Code](https://code.claude.com/docs/en/costs)）。即**编排模型 ≠ 辅助任务模型**是官方推荐姿势。

**effort 作为比换模型更轻的档位**：官方博客明确"effort 控制的是 Claude 为你做多少工作（读多少文件、用多少工具、多少步）而不只是思考时间"（[Choosing a Claude model and effort level in Claude Code](https://claude.com/blog/claude-model-and-effort-level-in-claude-code)）——与 §9.3 "reasoningEffort 先于换模型生效"的设想一致。

### 1.2 OpenAI Codex CLI：配置驱动的手动选择（细节未能核实）

开源仓库证实 Codex CLI 是本地编码 agent，配置集中在 `config.toml`，但仓库内 `docs/config.md`、`docs/slash_commands.md` 均为指向 [developers.openai.com/codex](https://developers.openai.com/codex) 的占位文档；该站点对当前网络全程 403（Vercel 边缘拦截，多次重试与归档代理均失败）。**可核实**的只有：仓库与 CLI 存在、配置体系外置（[openai/codex README](https://github.com/openai/codex)）；**未能核实**：`-m`/`/model` 具体行为、profile 切换、有无自动路由。就公开材料而言，Codex CLI 没有类似 Cursor Auto / Copilot Fusion 的自动路由声明——模型选择是启动/配置时的手动动作。

### 1.3 Cursor：Auto 模式 = 托管 ML 分类器路由（编码 agent 里最完整的"全自动"实现）

- **机制**："A machine-learning classifier routes each Auto request across a pool of models instead of you picking one yourself… The goal is to pick the cheapest model that still produces comparable results for that request."（[Cursor Router help](https://cursor.com/help/models-and-usage/cursor-router)）；官方文档同样表述为"runs a classifier on each agent request and routes it based on task type and complexity"（[Cursor Router docs](https://cursor.com/docs/cursor-router)）。
- **粒度与粘性**：每个 agent 请求分类一次；数据驱动、模型池由 Cursor 托管且随时间变化，**用户不能指定某请求用某模型**，只能选优化模式：Cost（旧 Auto）/Balance（新用户默认）/Intelligence（宣称约 20-30% 质量提升）。
- **UX 关键决策**："Underlying model: Display which model Auto routed to at the start of each response, or keep it hidden. **Hidden is the default and recommended, so results are judged on their own merit rather than by model name.**"（[docs](https://cursor.com/docs/cursor-router)）——默认隐藏实际模型，避免用户对模型名的成见影响对结果的判断。
- **管理面**：Impose Auto（Soft 默认开 Auto / Hard 锁死选择器）；封禁模型过多"reduces routing quality and can disable the router"——路由器需要一个"强且便宜"的池内模型（Grok 4.6）才能产生节省。
- **计费**：Cost 模式按 Cursor 模型计费走周池；Balance/Intelligence 按被路由模型 list price 计费（[Models & Pricing](https://cursor.com/docs/models-and-pricing)）。SDK 侧以模型 id `auto-smart` + `optimize_for` 参数暴露（同 docs）。
- **定位**：仅 Teams/Enterprise 可用——自动路由被当作**企业级成本治理功能**而非个人默认。

### 1.4 GitHub Copilot：手动 per-chat 切换 + Copilot Fusion 运行时编排

- **手动面**：聊天底部 CURRENT-MODEL 下拉换模型，"change the model during a chat"；组织策略可禁止成员换模型；聊天模型与**行内补全模型互相独立**（[Changing the AI model for Copilot Chat](https://docs.github.com/en/copilot/how-tos/copilot-in-your-ide/chat-with-copilot/change-the-chat-model)）。还可手动添加第三方 provider 模型进选择器。
- **自动面：Copilot Fusion**——"an intelligent runtime model router and orchestrator. It chooses models and execution patterns for your task, then returns a single response."选择 Fusion 时"you aren't selecting a specific model. You're choosing a system that routes and orchestrates models at runtime."（[About GitHub Copilot Fusion](https://docs.github.com/en/copilot/concepts/models/copilot-fusion)）。三个要点：
  1. **三种执行模式按任务选**：Single（单模型）/ Cascade（便宜模型起草 + judge 审查，不过关再升级强模型）/ Critique（一模型起草 + 多模型并行批判 + 原模型修订）；同一会话不同 prompt 可用不同模式。
  2. **防抖与缓存成本**："Routing occurs along **natural cache boundaries** and large changes in conversation complexity to avoid additional cache-related costs without quality improvements"——沿缓存边界和复杂度突变点才路由，避免中途换模型打断 prompt cache。
  3. **延迟纪律**："Choosing an execution pattern is a lightweight step that adds minimal latency… only adds model calls when a task warrants them."
- 它还把**实时系统健康度**纳入选型信号；effort 档位（用户选）与模型选择联动。

### 1.5 横向小结

| 产品 | 默认 | 自动切换有哪些 | 粒度 | 用户可控性 | 切换可见性 |
|---|---|---|---|---|---|
| Claude Code | 手动选模型 | ①opusplan（plan→exec 相位）②分类器标记→类别回退（**会话粘住**）③过载→回退链（**仅当前轮**） | 相位/会话/轮 | 高（auto/ask/off 三态开关） | 转录内通知 |
| Codex CLI | 手动（配置） | 未见公开证据（未能核实细节） | — | 高（推测） | — |
| Cursor | 手动选模型；Auto 仅 Teams/Ent | Auto=每请求 ML 分类器路由 | 请求 | 低（只能选 Cost/Balance/Intelligence） | 默认隐藏被路由模型，管理员可显 |
| GitHub Copilot | 手动 per-chat | Copilot Fusion=运行时路由+编排（单/级联/批判） | prompt | 中（effort 联动） | 单响应聚合呈现 |

**共性**：①没有一个产品把"全自动模型路由"作为个人用户的默认唯一入口——手动选择器始终保留；②自动切换都发生在**明确边界**（相位、类别标记、过载、prompt 边界），没有逐步连续重判；③切换必须可见（通知/日志），Cursor 甚至是"可见性可关"而非"无可见性"。

---

## 二、专用模型路由器的决策层设计

### 2.1 OpenRouter：一套路由器动物园（信号最多样）

**[Auto Router](https://openrouter.ai/docs/guides/routing/routers/auto-router.md)**（`openrouter/auto`）——**市场信号路由**：
- 决策层 = "fast, lightweight classifier"把 prompt 归入 **~30 个细粒度任务类型**（`code:debugging`、`agent:multi_step_planning`、`math`…），再按该任务类型下**社区 7 天滚动真实支出份额**（Share of Spend）排名选模型；
- 用户侧唯一旋钮是 `cost_tier`（low/medium/high/xhigh/max）；
- 候选过滤条件包含账号限制、guardrails、ZDR、`allowed_models` 与**输出模态要求**；
- 排名靠前的模型成为"主选 + fallbacks"，与故障转移天然融合；
- **失败安全**："If classification or rankings are ever unavailable, the router degrades gracefully to a default model set — **a request never fails because routing infrastructure hiccuped**."；
- **可审计**：`X-OpenRouter-Metadata: enabled` 头可在响应里拿到 `data.task_type`（分类结果），分类不可用时字段缺省。

**[Switchyard](https://openrouter.ai/docs/guides/routing/routers/switchyard-router.md)**（`nvidia/switchyard`，基于 [NVIDIA NeMo Switchyard](https://github.com/NVIDIA-NeMo/Switchyard)）——**自选模型池内的高/低成本档切换**，与我们场景最像：
- 用户给 ≤3 个候选模型，OpenRouter 按价格把最便宜者标为 efficient 档、最贵者标为 capable 档；
- 三种算法：`stage`（默认）"Scores the **tool results already in the conversation**, such as errors, repeated failures, and edits that landed. This scoring doesn't call a classifier or decision model… When the score isn't decisive… falls back to the judge, a small, fast model"；`capability` "Asks the judge on **every human turn** whether the efficient model can solve the task, and **reuses that choice for the turn's tool calls**"；`composite` "Runs `stage` on human turns, **remembers the chosen tier for the conversation, and holds it through long agent tasks** unless the tool results point elsewhere"；
- 失败按模型顺序 fallback；被选模型在响应 `model` 字段中回报。

**[Model Fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks.md)**：`models` 数组按优先级排列，"any error can trigger the use of a fallback model"（上下文超限、审核、限流、宕机），按实际应答模型计价——与 dsh-model-failover 的 failover 链同构。

**[Auto Exacto](https://openrouter.ai/docs/guides/routing/auto-exacto.md)**：对**带工具调用的请求默认开启**的 provider 排序优化，信号=实时吞吐、工具调用成功率（对返回的 tool call arguments 按 JSON Schema 校验）、自建基准——**把"工具调用能力"本身当作路由维度**。

其余：Pareto Router（"Pick a coding model by minimum coding score without choosing a specific model"，见 [docs 索引](https://openrouter.ai/docs/llms.txt)）、`:floor`/`:nitro` 变体（最低成本/最高速度）等，说明"按任务类型×成本档选模型"已是商品化能力。

### 2.2 RouteLLM（LMSYS）：学术基线，"胜率阈值"决策模型

- 论文：用人类偏好数据（Chatbot Arena）+ 数据增强训练路由器，在强/弱模型间做推理时选择；**成本降 2x 以上而不损回答质量**，且路由器**换强弱模型对无需重训**（迁移能力）（[RouteLLM: Learning to Route LLMs with Preference Data, arXiv:2406.18665](https://arxiv.org/abs/2406.18665)）。README 数字更具体：MT Bench 上**降本最高 85% 同时保持 95% GPT-4 表现**，比同类商业方案便宜 >40%（[lm-sys/RouteLLM README](https://github.com/lm-sys/RouteLLM)）。
- 决策机制极其简洁：路由器只需实现 `calculate_strong_win_rate`（给定 prompt 返回强模型胜率），**胜率 > 用户阈值 → 强模型，否则弱模型**（README "Adding a new router"）。四种内置路由器：`mf`（矩阵分解，推荐）、`sw_ranking`（相似度加权 Elo）、`bert`（BERT 分类器）、`causal_llm`（LLM 分类器）。
- 对我们的意义：**单标量阈值**是最小可行的路由决策面，天然支持"保守↔激进"旋钮；阈值即误判代价的调节器。

### 2.3 semantic-router（aurelio-labs）：毫秒级语义路由 + 校准置信度

- 定位："decides in **milliseconds**: it compares the semantic meaning of a request against your routes in vector space, or asks a small decision model in a single fast call. **Every decision comes with a confidence you can calibrate into a real probability.**"（[aurelio-labs/semantic-router README](https://github.com/aurelio-labs/semantic-router)）
- 关键设计：
  - **校准阈值**：`router.fit()` 用少量标注样本把原始相似度分校准成概率，`confidence_threshold` 之上才路由，"No route cleared the bar, so the router returned `None`"——**不确定就不动**；
  - **级联**：`Chain` "answers easy queries from a fast router and falls through to a slower one only when it isn't sure"；
  - **混合检索**：给 `IndexedRouter` 加 `sparse_encoder` "to weigh **exact keywords alongside meaning**"——关键词规则与语义分类不是二选一，而是同一层里的稀疏+稠密融合；
  - **多模态路由**：支持对图片做路由判定（Shrek vs not-Shrek 示例，[docs/07-multi-modal.ipynb](https://github.com/aurelio-labs/semantic-router/blob/main/docs/07-multi-modal.ipynb)）。

### 2.4 Martian：RouterBench（产品站点未能核实）

Martian 官网为 JS 单页应用，web_fetch 仅得空壳，**产品细节未能直接核实**（标注）。可核实的是其论文 [RouterBench: A Benchmark for Multi-LLM Routing System, arXiv:2403.12031](https://arxiv.org/abs/2403.12031)：提供 40.5 万+ 条真实推理结果数据集与路由理论框架，系统比较各类路由策略的收益边界——"no single model can optimally address all tasks… routing systems combine the strengths of various models"。代码仓库 [withmartian/martian-evals](https://github.com/withmartian/martian-evals)（注：抓取时其 README 为上游 evals 框架的 fork 文本，论文本体见 arXiv）。

### 2.5 NotDiamond：面向编码 agent 的预训练路由器

- 定位："model routing is **especially effective in long-running coding agent settings**. Instead of hardcoding a single model for all tasks, Not Diamond analyzes each input and predicts which model will provide the highest quality response at the lowest cost"（[What is Model Routing?](https://docs.notdiamond.ai/docs/what-is-model-routing)）。
- 产品形态：预训练 Chat 路由器 / **预训练 Code 路由器**（"reduces your long-horizon coding agent cost by **30%+** without affecting the quality of the code"，[Pre-trained router: Code](https://docs.notdiamond.ai/docs/pre-trained-router-code.md)）/ 基于自家数据训练自定义路由器（应对领域特异性）。
- 三种权衡模式：**Quality（默认）/ Cost / Latency**——把"你想要什么"从"你选哪个模型"里抽象出来。

### 2.6 Portkey：规则驱动的网关路由（<1ms）

- 开源 AI Gateway："**Blazing fast (<1ms latency)** with a tiny footprint (122kb)"，能力=自动重试、fallback、负载均衡、**条件路由**、guardrails、语义缓存；覆盖 1600+ 语言/视觉/音频/图像模型（[Portkey-AI/gateway README](https://github.com/Portkey-AI/gateway)）。
- 条件路由是**纯声明式规则**：config 里 `strategy.mode: "conditional"` + conditions 数组按请求 metadata 做类 Mongo 查询（`{"metadata.user_plan": {"$eq": "paid"}} → anthropic-claude`），配 `default` 兜底目标（[conditional-routing.ts 示例](https://github.com/Portkey-AI/gateway/blob/main/cookbook/integrations/vercel/app/examples/generate-text/conditional-routing.ts)）。
- 注：官方文档站 docs.portkey.ai 抓取时 SSL 526 故障，本文引用其 GitHub 仓库一手材料替代。

### 2.7 模式归纳

| 路由器 | 决策信号 | 决策执行 | 成本感知 | 判定延迟 |
|---|---|---|---|---|
| OpenRouter Auto | 轻量分类器（~30 任务类）+ 社区 7 天支出份额 | 主选+fallbacks | cost_tier 五档 | in-flight 分类，无独立往返 |
| Switchyard | 工具结果评分（零调用）→ 小 judge 模型 | 二档（efficient/capable）+ 粘住 | 候选按价格分层 | stage 模式零额外模型调用 |
| RouteLLM | 偏好数据训练的分类器/矩阵分解 | 胜率>阈值→强模型 | 阈值即成本-质量旋钮 | 本地推理（分类器） |
| semantic-router | 向量相似度 / 小决策模型 | 置信度>阈值才路由；Chain 级联 | — | 毫秒级 |
| NotDiamond | 预训练/自定义路由模型 | 三模式 Quality/Cost/Latency | 模式即旋钮 | 未披露 |
| Portkey | 请求 metadata 规则 | 条件→目标，default 兜底 | 负载均衡权重 | <1ms 网关开销 |
| Copilot Fusion | 任务能力信号+系统健康度 | 单/级联/批判三模式 | effort 联动 | "轻量步骤，极小延迟" |

**共识设计**：①决策都是"信号→档位/候选过滤→阈值裁决"三段式；②全部带兜底（default 模型 / fallback 链 / None 不动）；③延迟预算都在毫秒~零额外调用量级。

---

## 三、输入模态路由与「工具/路由」解耦

### 3.1 模态 = 候选过滤条件，而非"切换对话模型"

- OpenRouter 统一 API 里图片用 `input_image` 内容类型发给"vision-capable models"，模态能力是**模型目录属性**，客户端据此筛选（[Multimodal Capabilities](https://openrouter.ai/docs/guides/overview/multimodal/overview.md)）；Auto Router 的候选过滤条件里显式包含"output-modality requirements"（[Auto Router](https://openrouter.ai/docs/guides/routing/routers/auto-router.md)）。
- semantic-router 支持直接**以图片为路由输入**做多模态路由判定（README Multi-modal Routes）。
- Portkey 把 vision/audio/image 模型纳入同一网关路由面（README）。
- 对应到 DSH：等价物是建链时用 `llm.resolveModelInfo(...).inputModalities` 过滤 vision 链（§五已有设计）——**先过滤能力，再谈路由**，业界无一是"先选了文本模型再临时换"。

### 3.2 生成与理解是两条路径（解耦的证据）

- OpenRouter 把图像/视频**生成**放在**专用 API**（"dedicated Image API"、异步视频生成 API），与对话/推理请求完全分离（[Multimodal Capabilities](https://openrouter.ai/docs/guides/overview/multimodal/overview.md)）——生成是端点能力，不是对话模型属性。
- 编码 agent 侧同理：生成素材由工具承担（DSH 先例：workbuddy `imageToolEnabled`/`imageModelIds`，见 §9.2，不重复）；LLM 路由只在"理解"（看参考图/审查生成结果）时需要 vision。
- 结论与 §9.2 一致：**"着陆页→切 flash"的正确拆解是 L0 视觉输入路由（看图步切 flash）+ 生成工具内选模型（编排模型不变）**。业界无人通过切换对话模型来获得生成能力。

### 3.3 工具调用能力本身是路由信号

OpenRouter Auto Exacto 对**所有带工具的请求默认开启** provider 级重排（吞吐×工具调用成功率×基准，工具参数按 JSON Schema 校验）（[Auto Exacto](https://openrouter.ai/docs/guides/routing/auto-exacto.md)）。启示：在 agent 场景，"本步是否带工具调用/工具结果"既是路由信号（Switchyard stage 的输入），也可作为未来的路由维度（工具密集步倾向指令跟随更强的模型）。

---

## 四、已知坑与业界对策

**① 路由抖动 / 翻转（flip-flop）**
- *对策 A：切点对齐自然边界*。Copilot Fusion "routing occurs along natural cache boundaries and large changes in conversation complexity"（[Fusion](https://docs.github.com/en/copilot/concepts/models/copilot-fusion)）；Claude Code opusplan 只在 plan→execution 相位切换（CC-Model-Doc）。
- *对策 B：相位/会话粘住*。Switchyard `composite` "remembers the chosen tier for the conversation, and holds it through long agent tasks unless the tool results point elsewhere"；`capability` 每人类轮判一次并"reuses that choice for the turn's tool calls"（[Switchyard](https://openrouter.ai/docs/guides/routing/routers/switchyard-router.md)）；Claude Code 分类器回退后会话粘住、需手动 `/model` 回切（CC-Model-Doc）。
- *对策 C：轮级回切试探*。Claude Code 可用性回退链"switch lasts for the current turn only, so your next message tries the primary model first again"（CC-Model-Doc）——**每用户消息后重试主模型**，是另一种防粘死设计。
- *对策 D：UX 稳定感*。Cursor 默认隐藏被路由模型，"results are judged on their own merit rather than by model name"（[Cursor Router](https://cursor.com/docs/cursor-router)）——用户感知不到翻转，抱怨就消失。

**② 上下文一致性（换模型对上下文/prompt cache 的破坏）**
- 缓存成本是 Copilot Fusion 明文处理的一级约束（沿缓存边界路由以"avoid additional cache-related costs"）；Claude Code 的 resume 保留原模型、子代理在启动时解析继承模型（CC-Model-Doc）——**模型身份被当作会话状态的一部分**。
- DSH 特有变体已在 §二关卡 3 记录（文本模型回切后历史图片被投影为占位符）——业界对照物是"转写/摘要化"（把模态信息压成文本再进通用上下文），即 §四方案 B 的思路。

**③ 路由判定延迟**
- 量级谱系：Portkey 网关 <1ms；semantic-router 毫秒级；OpenRouter in-flight 分类（无独立往返）；Switchyard stage **零额外模型调用**（只看已有工具结果），不确定才请 judge；Copilot Fusion "lightweight step… minimal latency"。共性：**绝不为路由加一次显式的"前置 LLM 往返"**，分类器要么本地、要么与主请求同飞、要么复用已有信息。我们的 L2（flash 分类器每用户轮一次 0.5-1s，仅规则未命中时，§9.1）处于该谱系的保守端，可接受。

**④ 分类错误的代价**
- *不确定就不动*：semantic-router 校准阈值 + None；RouteLLM 胜率阈值（阈值即质量-成本曲线旋钮）；两者都把"默认侧安全"做成机制。
- *错误分类可回溯*：OpenRouter 把 task_type 写进响应元数据；Claude Code 把每次切换写进转录通知。
- *误判的护栏*：Cursor 指出封禁过多模型会"reduce routing quality and can disable the router"——路由器对池的完整性有最低要求；NotDiamond 推荐领域数据训练自定义路由器对抗通用分类器的领域漂移。
- *错误分类决定是否切换*：Claude Code 回退链明确鉴权/计费/限流/传输错误**不**触发模型切换（CC-Model-Doc）——错误类型先分类，再决定路由动作；这正是 dsh-model-failover 既有 retryOn 分类的同款思想（我们的插件在限流时换号是业务选择，但"先分类错误再行动"的模式一致）。

**⑤ 路由基础设施自身的失败**
- OpenRouter Auto Router："degrades gracefully to a default model set — a request never fails because routing infrastructure hiccuped"；Claude Code opusplan 升级被 allowlist 排除即跳过升级；分类器回退被阻止时"no fallback occurs… the session's model is unchanged"。**路由层失效 = 回到无路由行为，永不放大故障**——与 §八 fail-closed to stock 完全同构。

---

## 五、对本项目的可借鉴结论

1. **切点对齐自然边界 + 相位粘住，是业界防翻转的标准答案**（opusplan、Copilot Fusion 缓存边界、Switchyard composite/capability）。落地：L0/L1 路由判定结果在"用户新消息或工具阶段变化"前保持粘住（§9.3 滞回），不要每个 agent step 独立重判；同相位内即使信号波动也不切。
2. **确定性信号优先、分类器只兜底，已被三条独立产品线验证**（Switchyard stage 先看工具结果零调用→不确定才 judge；semantic-router 稀疏关键词与稠密语义融合；OpenRouter 分类仅 in-flight）。落地：坚持 M1（L0 模态+L1 工具轨迹，全确定性）→ M2（关键词规则）→ M3（flash 分类器）的顺序；flash 分类器只在规则未命中时触发，且结果按用户轮缓存（§9.4）。
3. **轮级/会话级回切语义要显式选择**：Claude Code 给了两种现成模式——可用性回退"仅当前轮，下一用户消息重试主模型"vs 分类器回退"会话粘住+手动回切"。落地：图片步走 flash 的 L0 路由天然是"步级"，但**回切默认模型应发生在下一个自然边界**（无图的后续步），并像 Claude Code 一样在 UI/日志给出切换通知，避免"悄悄回来"。
4. **把"你想要什么"抽象成模式，而不是让用户逐场景配模型**：Cursor 的 Cost/Balance/Intelligence、NotDiamond 的 Quality/Cost/Latency 都是三档旋钮。落地：GUI 在场景路由表之上叠一个"保守（仅确定性路由）/均衡（+关键词）/激进（+分类器）"总开关，比让用户理解 L0/L1/L2 更友好；逐场景 YAML 表保留给高级用户（§五配置设计的进阶面）。
5. **路由器必须有"失效即退回原生"的硬保证**（OpenRouter 优雅降级、opusplan 排除即跳过、Claude 回退被阻止则不切）。落地：§八 的 fail-closed to stock 与此完全同构，应作为验收标准写进 M0 spike（拔掉路由监听器=行为回到未装插件）。
6. **可见性与可审计是标配**：Claude Code 转录通知 + `/status` 类查询、OpenRouter 响应元数据回传 task_type、Cursor（可开启的）底层模型显示。落地：switches.log 每次判定记"类别/依据/命中规则"（§9.3 已有）之外，在卡片或轨迹里暴露"本步被判为 vision 步"的一等标签，方便用户复核误判。
7. **模态路由先做能力过滤**：业界一律把模态当作候选集过滤条件（OpenRouter 候选过滤含模态、semantic-router 多模态路由、Portkey 统一目录）。落地：vision 故障转移链只收 `inputModalities` 含 image 的条目（§五已设计）；同理未来扩展 audio/长上下文场景时也是"过滤"而非"例外"。
8. **生成与理解解耦再次被证实**：OpenRouter 把图像/视频生成放专用 API，Auto Exacto 把工具调用当 provider 排序信号。落地：坚持 §9.2 的结论——素材生成走工具内选模型，flash 只承担"看图"步；不要为生成能力切换编排模型。
9. **首次自动切换时给一次"询问并记住"**：Claude Code 首次触发标记切换时交互式询问"以后自动吗"并存为设置。落地：首次 L0 自动切 flash 时弹出一次性确认（记住/不再问/关闭功能），既保留全自动默认体验的可能性，又消除失控感——尤其我们还有客户端钩子（策略①）这种 C 级触点，用户知情更显重要。
10. **错误分类先于路由动作**：Claude Code 回退链明确哪些错误类别不触发切换；Auto Exacto 用 schema 校验定义"工具调用失败"。落地：场景路由与现有 failover 合并时（§四方案 A 的同一个 prepend 监听器），保持"场景判定→路由改写→错误分类→failover"的顺序，确保路由改写不吞掉 retryOn 语义。

---

## 附录：来源清单与核实状态

| 来源 | 状态 |
|---|---|
| [Claude Code — Model configuration](https://code.claude.com/docs/en/model-config) | ✅ 全文抓取（别名表、opusplan、Automatic model fallback、Fallback model chains、switchModelsOnFlag、allowlist 交互） |
| [Claude Code — Costs](https://code.claude.com/docs/en/costs) | ✅（子代理 haiku 建议） |
| [Anthropic Blog — Choosing a Claude model and effort level](https://claude.com/blog/claude-model-and-effort-level-in-claude-code) | ✅（effort 语义） |
| [Cursor — Cursor Router (docs)](https://cursor.com/docs/cursor-router) ／ [Cursor Router (help)](https://cursor.com/help/models-and-usage/cursor-router) ／ [Models & Pricing](https://cursor.com/docs/models-and-pricing) | ✅ |
| [GitHub Copilot — Changing the chat model](https://docs.github.com/en/copilot/how-tos/copilot-in-your-ide/chat-with-copilot/change-the-chat-model) ／ [About Copilot Fusion](https://docs.github.com/en/copilot/concepts/models/copilot-fusion) ／ [Supported AI models](https://docs.github.com/en/copilot/reference/ai-models/supported-models) | ✅（经 docs.github.com Article API） |
| [OpenRouter — Auto Router](https://openrouter.ai/docs/guides/routing/routers/auto-router.md) ／ [Switchyard](https://openrouter.ai/docs/guides/routing/routers/switchyard-router.md) ／ [Model Fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks.md) ／ [Auto Exacto](https://openrouter.ai/docs/guides/routing/auto-exacto.md) ／ [Multimodal](https://openrouter.ai/docs/guides/overview/multimodal/overview.md) ／ [docs 索引](https://openrouter.ai/docs/llms.txt) | ✅ |
| [RouteLLM — arXiv:2406.18665](https://arxiv.org/abs/2406.18665) ／ [lm-sys/RouteLLM README](https://github.com/lm-sys/RouteLLM) | ✅ |
| [semantic-router — aurelio-labs README](https://github.com/aurelio-labs/semantic-router) | ✅ |
| [RouterBench (Martian) — arXiv:2403.12031](https://arxiv.org/abs/2403.12031) | ✅（论文）；martian.ai 产品页为 JS 壳，**产品细节未能核实** |
| [NotDiamond — What is Model Routing](https://docs.notdiamond.ai/docs/what-is-model-routing) ／ [Pre-trained router: Code](https://docs.notdiamond.ai/docs/pre-trained-router-code.md) | ✅ |
| [Portkey — gateway README](https://github.com/Portkey-AI/gateway) ／ [conditional-routing.ts](https://github.com/Portkey-AI/gateway/blob/main/cookbook/integrations/vercel/app/examples/generate-text/conditional-routing.ts) | ✅（官方 docs 站 SSL 526，改引仓库） |
| [openai/codex — README](https://github.com/openai/codex) ／ [docs/config.md](https://github.com/openai/codex/blob/main/docs/config.md) | ✅ 仓库层；**developers.openai.com 全程 403，Codex 配置细节未能核实** |
| web_search 工具 | ❌ 后端故障（402），本次未使用 |

*本文件仅新增于 research/team/，未改动仓库其他文件。*
