# GLM 生态能力矩阵 —— 自动模型路由实施依据

> 调研人：glm-research ｜ 日期：2026-11-01 ｜ 服务对象：`RESEARCH-AUTO-MODEL-SWITCH.md` §一/§二/§九 的实施方案
> 方法：宿主 web_search 故障（DeepSeek 端点 402），改用 web_fetch 直抓官方文档。
> docs.bigmodel.cn / docs.z.ai 为 Mintlify 站点，URL 加 `.md` 后缀可获取 Markdown 原文，本文全部事实以此方式取证。
> 可信度标注：**[官方文档]** = 官方页面明文；**[推断]** = 多条官方事实交叉推出、未逐字见诸文档；**[未证实]** = 无法核实。

---

## 0. 给实施的硬结论（TL;DR）

1. **套餐内只有两个对话模型**：GLM-5.3（纯文本旗舰）与 GLM-5.3-Flash（原生多模态）。历史模型名自动映射：GLM-5.2/5.1→GLM-5.3，GLM-5-Turbo/GLM-4.7→GLM-5.3-Flash。[官方文档](https://docs.bigmodel.cn/cn/coding-plan/overview.md)
2. **glm-4.6v 不在套餐内**。视觉备选链若要含 4.6v，必须配标准 API key（按量计费）或用免费的 glm-4.6v-flash。[官方文档](https://docs.bigmodel.cn/cn/coding-plan/overview.md)、[价格](https://docs.bigmodel.cn/cn/guide/start/pricing.md)
3. **glm-5.3-flash 就是套餐内的最优视觉路由目标**：支持图/视频/文件输入，1M 上下文，积分系数是 glm-5.3 的 1/3（额度 ×3），标准 API 价仅 glm-5.3 的 1/10。[官方文档](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash.md)
4. **思考档位（reasoning_effort: low/high/max）可作为"复杂度适配"第一级**：5.3 系列强制思考不可关（thinking.type=disabled 直接报错），但 Coding Plan 端点会把 none/minimal 容错映射为 low，不会失败 → 插件可以安全地下调档位省钱，上调不换模型。[官方文档](https://docs.bigmodel.cn/cn/guide/capabilities/thinking.md)
5. **图片/视频生成模型（GLM-Image/CogView-4/CogVideoX-3）不能走 Coding Plan 额度**：套餐端点只承载 Chat/Anthropic/Responses 三种对话协议，生成 API 是独立端点按次计费 → "着陆页素材生成"必须走工具内模型 + 标准 API key，印证 RESEARCH §9.2 的"生成路径=工具能力"判断。[推断，证据链见 §4](https://docs.bigmodel.cn/cn/coding-plan/tool/others.md)
6. **错误分类器主锚点是 429 + 业务码**（body JSON `error.code`）：1302=账户限流、1305=平台过载、1308/1310=周期额度耗尽、1309=套餐过期、1311=模型不在套餐、1113=余额不足。[官方文档](https://docs.bigmodel.cn/cn/api/api-code.md)
7. **套餐耗尽不透支**：额度用完直接 429 等待 5 小时周期重置，不会自动扣账户余额 → failover 链的"换号"策略在这里是刚需。[官方文档](https://docs.bigmodel.cn/cn/coding-plan/faq.md)
8. **DSH 不在官方"指定工具"清单内**（清单为 Claude Code/Codex/Cline/OpenCode/Cursor 等 18 个 Coding Agent + 5 个通用 Agent 工具）。套餐条款明确"仅限指定工具使用，用于非支持工具将被限制权益"。插件用户用 Coding Plan key 直连 DSH 属于条款灰区，需在文档中明示风险。[官方文档](https://docs.bigmodel.cn/cn/coding-plan/tool/others.md)

---

## 1. 能力矩阵总表（对话模型）

| 维度 | GLM-5.3 | GLM-5.3-Flash | GLM-5.3-FlashX | GLM-4.6V | GLM-4.6V-Flash |
|---|---|---|---|---|---|
| 定位 | 旗舰，复杂软件工程/Agent | GLM-5 系首个原生多模态，320B 总参/18B 激活 | flash 高速版，200 tokens/s | 视觉推理 106B（12B 激活） | 9B 免费视觉模型 |
| 输入模态 | **仅文本** | **视频、图像、文本、文件** | 图/视频/文件/文本 | 视频、图像、文本、文件 | 视频、图像、文本、文件 |
| 上下文 / 最大输出 | 1M / 128K | 1M / 128K | 1M / 128K | 128K / 32K | 128K / 32K |
| 思考 | 强制开启；effort low/high/max（默认 max） | 强制开启；同左（推荐 max） | 同 flash | **可开可关**（动态思考） | 可开可关 |
| Coding Plan 套餐内 | ✅ | ✅（额度 ×3） | ❌（1311 报错） | ❌ | ❌（免费但需标准端点） |
| 积分系数 In/Cached/Out | 6.9 / 1.7 / 24 | 2.3 / 0.56 / 8 | — | — | — |
| 标准 API 价（元/百万 tok，In/Out/缓存命中） | 8 / 28 / 2 | 0.8 / 2.8 / 0.23 | 2 / 7 / 0.57 | <32K:1/3/0.2；[32K,128K):2/6/0.4 | 免费 |
| z.ai 国际价（USD/百万 tok，In/Out） | $1.4 / $4.4 | $0.15 / $0.50 | $0.37 / $1.25 | $0.3 / $0.9 | 免费 |
| 多图上限 | — | 50 张 | 50 张 | 50 张 | 50 张（同系列规格） |
| 图片单张限制 | — | 5M，≤6000×6000，jpg/png/jpeg | 同左 | 同左 | 同左 |
| 视频输入 | — | ≤200M，mp4/mkv/mov | 同左 | ≤200M | ≤200M |
| Function Calling | ✅ | ✅（推荐 tool_stream） | ✅ | ✅（原生多模态工具调用） | ✅ |

依据：[glm-5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3.md) ｜ [glm-5.3-flash](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash.md) ｜ [glm-4.6v](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4.6v.md) ｜ [glm-4.6v-flash](https://docs.bigmodel.cn/cn/guide/models/free/glm-4.6v-flash.md) ｜ [模型概览](https://docs.bigmodel.cn/cn/guide/start/model-overview.md) ｜ [API 定价](https://docs.bigmodel.cn/cn/guide/start/pricing.md) ｜ [z.ai pricing](https://docs.z.ai/guides/overview/pricing.md) ｜ [对话补全 API 参数](https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E5%AF%B9%E8%AF%9D%E8%A1%A5%E5%85%A8.md)

> 注意：glm-4.6v 的多图/图片/视频限制数字来自 Chat Completion API 参数 schema 中"GLM-5.3-Flash 系列 GLM-5V-Turbo GLM4.6V GLM4.5V 系列"的并列表述，4.6v-flash 未单独点名，按同系列规格标注 [推断]。

---

## 2. GLM Coding Plan（国内 bigmodel.cn / 国际 z.ai）

### 2.1 模型与额度 [官方文档]

- 套餐模型：**所有档位均支持 GLM-5.3 与 GLM-5.3-Flash**；GLM-5.3-FlashX 暂未开放（调用将得到 429/1311"当前订阅套餐暂未开放权限"）。
- 积分额度（个人版，双周期）：

| 套餐 | 5 小时积分 | 每周积分 |
|---|---|---|
| Lite | 2,000 | 10,000 |
| Pro | 12,000 | 60,000 |
| Max | 28,000 | 140,000 |

- 积分公式：`(输入tok×In系数 + 缓存命中tok×Cached系数 + 输出tok×Out系数) / 10000`；MCP 调用 = 次数 × Out系数（联网搜索/网页读取/开源仓库 MCP 均 1.2，视觉理解 MCP 并入 flash 的 8）。
- **非高峰（工作日 14:00-18:00 UTC+8 之外，含周末全天）积分 5 折**。
- 刷新：5 小时积分"自消耗起 5 小时"动态刷新；周积分按下单时刻 7 天周期。
- 体验卡 2,000 积分；额度重置卡为活动权益。

### 2.2 端点与 API Key 分类 [官方文档：API Key 分类管理（2026-10-16 公告）]

| 用途 | Base URL |
|---|---|
| 套餐·OpenAI Chat 协议 | `https://open.bigmodel.cn/api/coding/paas/v4` |
| 套餐·Anthropic 协议 | `https://open.bigmodel.cn/api/anthropic` |
| 套餐·OpenAI Responses 协议 | `https://open.bigmodel.cn/api/v1` |
| 标准 API（按量/资源包） | `https://open.bigmodel.cn/api/paas/v4`（及 /api/v1、/api/anthropic） |

- **2026-10-16 起新建 Key 按类型计费**：标准 Key / 个人套餐 Key / 团队套餐 Key 互不通用，换端点不改变计费归属。
- **历史"兼容 Key"按端点判额度**：配 coding 端点→扣套餐；配标准端点→扣余额（即使套餐有余量）。这正是 FAQ"买了套餐还报 1113/扣余额"的根因。
- glm-5.3 页特别提示：**订阅过 Coding Plan（含已过期）的账号，暂时只能用 OpenAI Chat Completion 协议调模型 API**。
- z.ai 国际侧同样存在 Coding Plan（订阅入口 z.ai/subscribe，套餐自 $18/月起；错误 1309 跳转 z.ai/subscribe）。z.ai 具体档位积分数字因订阅页 JS 渲染**[未证实]**。

### 2.3 限流 [官方文档：速率限制]

- 限流维度是**并发数**（在途请求数），非 RPM/TPM；Coding Plan 按 套餐档位动态调整，原则 **Max > Pro > Lite**，低峰期动态上浮，不支持申请提额。
- 官方建议并发项目数：Lite 1 个、Pro 1-2 个、Max 2+ 个（可用 Subagent 并发）。
- 标准 API 并发与用户权益等级（V0-V3 积分）挂钩；生成类模型单列（如 CogView-4 并发 5/10/15/20）。

### 2.4 指定工具清单（合规边界）[官方文档：接入工具]

- **Coding Agent（18）**：ZCode(1.5 倍用量)、Claude Code、Claude for IDE、Codex、OpenCode、Pi Coding Agent、TRAE、CodeBuddy、Lingma、Qoder、Kilo、MonkeyCode、Cline、Droid、Roo、Crush、Goose、Cursor。
- **通用 Agent（次级调度/尽力交付，5）**：AutoClaw(1.5 倍用量)、WorkBuddy、OpenClaw、Cherry Studio、Hermes Agent。
- **DSH 不在清单**。套餐条款："仅限订阅人专享/仅限指定工具使用……用于非支持工具将被限制权益"；3 次以上违规可能封号（usage-notes）。插件应把"用 Coding Plan key 接入 DSH 属于用户自担的条款灰区"写进文档与免责声明。

---

## 3. 视觉能力细节（路由 L0 层的接口事实）

### 3.1 消息格式 [官方文档：glm-5.3-flash 模型页 + Chat Completion API]

```json
{
  "model": "glm-5.3-flash",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "image_url", "image_url": { "url": "https://... 或 data:image/png;base64,..." } },
      { "type": "image_url", "image_url": { "url": "..." } },
      { "type": "text", "text": "这两张图有什么区别？" }
    ]
  }],
  "thinking": { "type": "enabled", "clear_thinking": false },
  "reasoning_effort": "max", "temperature": 1, "top_p": 0.95
}
```

- 图片：`image_url.url` 支持 URL（推荐）与 Base64 Data URL；**多图 = 多个 image_url 块，上限 50 张**（GLM-5.3-Flash 系列 / GLM-5V-Turbo / GLM-4.6V / GLM-4.5V）。
- 图片硬限制：**单张 ≤5M，像素 ≤6000×6000，格式 jpg/png/jpeg**。
- 视频：`{ "type": "video_url", "video_url": { "url": "https://..." } }`；**≤200M，mp4/mkv/mov**（GLM-4V-Plus 是 20M/30s）。**视频只收 URL，未提供 base64 形态**（schema 中 video_url 仅 url 字段）→ 插件做视频转写需先传图床/对象存储。
- 文件：`{ "type": "file", "file": { "file_id" | "file_url" | "file_data": "data:<MIME>;base64,..." } }`，单文件 ≤50M，最多 50 个（pdf/txt/word/jsonl/xlsx/pptx 等）。
- **glm-4.6v 明确"不支持同时理解文件、视频和图像"**（同一请求混合三类模态）；glm-5.3-flash 文档无此限制表述，且其定位就是"原生多模态"混合输入（截图+文本+文件）[glm-4.6v 多模态理解注记](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4.6v.md)。
- pi-ai 适配器向 flash 发 base64 的路径（RESEARCH §六.3 疑点）可判定为**官方支持形态**（文档明示 Base64 Data URL）。

### 3.2 视觉理解 MCP（套餐内视觉能力的"官方兜底"）[官方文档]

- 套餐所有档位附带 4 个专属 MCP：**视觉理解、联网搜索、网页读取、开源仓库（zread）**，与模型共享积分。
- 视觉理解 MCP = 本地 `@z_ai/mcp-server`（≥0.1.2 用 flash 内核），工具：`ui_to_artifact`、`extract_text_from_screenshot`、`diagnose_error_screenshot`、`understand_technical_diagram`、`analyze_data_visualization`、`ui_diff_check`、`image_analysis`、`video_analysis`（MP4/MOV/M4V，本地 ≤8M）。
- **在 Claude Code 中服务端已内置 image_analysis 工具（免装）**；其他客户端粘贴图片默认直调模型接口，最佳实践是引用本地路径让 MCP 处理 → 这正是本插件"方案 B 转写管线"的官方同构先例（本地图片→视觉模型→文字描述）。
- MCP 计费：调用次数 × flash 的 Out 系数（8）→ 转写一图的积分成本 ≈ (8×次数)/10000，非常便宜。

---

## 4. 图像 / 视频生成（"着陆页素材"路径）

### 4.1 生成模型清单与价格 [官方文档：API 定价 / 模型页]

| 模型 | 能力 | 国内价 | z.ai 国际价 | 规格 | 端点 |
|---|---|---|---|---|---|
| GLM-Image | 文生图（旗舰，9B+7B 自回归+DiT） | 0.1 元/次 | $0.015/张 | 512-2048px、32 倍数、1:1/3:4/4:3/16:9；有异步接口 | `/api/paas/v4/images/generations` |
| CogView-4 | 文生图（开源，支持汉字） | 0.06 元/次（Batch 0.03） | $0.01/张 | 任意分辨率（范围内） | 同上，model=cogview-4-250304 |
| CogView-3-Flash | 文生图 | **免费** | — | 多分辨率 | 同上 |
| CogVideoX-3 | 视频生成（旗舰） | 1 元/次 | $0.2/条 | 5s/10s、最高 4K、30/60fps、首尾帧、带音频 | 异步接口 `/api/paas/v4/videos/generations` |
| CogVideoX-2 | 视频生成 | 0.5 元/次 | — | 多分辨率 | 异步 |
| CogVideoX-Flash | 视频生成 | **免费** | — | 图/文 | 异步 |

开源权重：[zai-org/CogView](https://github.com/THUDM/CogView)、[zai-org/CogVideo（CogVideoX）](https://github.com/THUDM/CogVideo)。

### 4.2 Coding Plan 端点能否调用生成模型？——**不能（走套餐额度）** [推断，证据链]

1. 套餐概览明文："可用模型 = GLM-5.3、GLM-5.3-Flash"+ 4 个 MCP；套餐权益表述为"图像视频**理解**"（understanding），从未提及生成。
2. 套餐端点文档仅列 Chat Completion / Anthropic / Responses 三种**对话**协议；图像生成（`/images/generations`）、视频生成（异步）是标准 API 域下的独立路径。
3. 错误码 1311"当前订阅套餐暂未开放 ${model_name} 权限"（429）即"套餐 Key 调套餐外模型"的失败形态。
4. FAQ："套餐仅限指定工具……官网体验中心不支持使用编码套餐"；生成类调用按次计费，与积分制（token 公式）不兼容。

→ **结论**：着陆页素材生成必须配置**标准 API Key（扣账户余额）**，作为"工具内模型"实现（对齐 dsh-connect-workbuddy 的 imageToolEnabled 先例）；对话模型（5.3 编排 / flash 看参考图）无需为"生成"切换。实际用套餐 Key 调 cogview-4 的报错形态未实测 **[未证实，预期 429/1311 或 400/1211]**。

---

## 5. 思考档位（复杂度适配的轻量手段）

### 5.1 参数事实 [官方文档：深度思考 / 思考模式 / glm-5.3 页]

| 参数 | GLM-5.3 / 5.3-Flash / 5.3-FlashX | GLM-4.6V 系列 | GLM-5.2 |
|---|---|---|---|
| `thinking.type` | **仅 enabled，传 disabled 直接报错**（迁移提示：先改 enabled 再换模型 ID） | enabled / disabled（动态思考，可关） | enabled / disabled |
| `reasoning_effort` | low / high / **max（默认）**，其他值报错 | — | max/xhigh/high/medium/low/minimal/none |
| `thinking.clear_thinking` | 默认 true；false = Preserved Thinking（**Coding Plan 端点默认开，标准端点默认关**） | 同 | 同 |

- **Coding Plan 端点的容错映射**：传 none/minimal/low → low；medium/high → high；xhigh/max → max（不会报错）。
- Claude Code 侧 `/effort` 命令与映射表（显式 effort > thinking 开关 > 默认 max；disabled 也归 low 继续轻量思考）说明**档位下调是端到端安全的**。
- 交错思考（interleaved，4.5 起）+ 保留式思考（preserved）：工具轮次间推理连续；preserved 要求原样回传 reasoning_content，否则降效并影响缓存命中 → 插件若改写历史消息（转写方案 B）**必须原样保留 reasoning_content 块**。

### 5.2 对路由设计的含义

- RESEARCH §9.3 的"复杂度适配第一级 = reasoningEffort"**完全可行**：DSH 的 LlmCallConfig 已有 reasoningEffort 字段，GLM 端三档即 low（简单文案/格式化）/high（常规编码）/max（复杂逻辑/长程任务），且 Coding Plan 端点对非法值容错映射，插件写错也不会炸请求。
- 思考不可关闭 ⇒ "低档 = 关思考省 token" 的预期应修正为 "低档 = 轻量思考"；真正零思考需换 GLM-5.2（标准 API）或 4.6v（可关思考）。
- 高峰期（工作日 14:00-18:00）与非高峰积分 5 折 → 档位下调的省钱收益在高峰期翻倍。

---

## 6. 速率限制与额度耗尽的报错形态（分类器适配表）

响应形态：HTTP 状态码 + body JSON `{"error":{"code":"...","message":"..."}}`；流式调用中途异常改由 `finish_reason` 返回。[官方文档：错误码](https://docs.bigmodel.cn/cn/api/api-code.md)（z.ai 国际侧码表完全一致，[EN](https://docs.z.ai/api-reference/api-code.md)）

| 业务码 | HTTP | 语义 | 分类器建议动作 |
|---|---|---|---|
| 1113 | 429 | 账户欠费/无资源包 | 换凭据（failover 链下一家）；同 key 重试无意义 |
| 1302 | 429 | 账户速率（并发）限制 | 降并发/短暂退避后同 key 重试；可并行换号 |
| 1305 | 429 | 模型访问量过大（平台过载） | 指数退避重试同模型；持续失败才降级模型 |
| 1308 | 429 | 用量上限（含 ${next_flush_time} 重置时间） | **解析 next_flush_time** → 冻结该 key 至该时刻，换号/换模型 |
| 1310 | 429 | 每周/每月上限 | 同上（周期更长，优先换号） |
| 1309 | 429 | Coding Plan 套餐已到期 | 标记凭据失效，提醒续订；换号 |
| 1311 | 429 | 套餐未开放该模型（如 FlashX） | 路由层剔除该模型对套餐 key 的配对 |
| 1313 | 429 | 公平使用策略限流 | 提示用户申诉；换号 |
| 1314-1321 | 429 | 团队/企业套餐过期、5h/7d 上限+超额付费不可用等 | 换号；解析 next_flush_time |
| 1000/1001/1003 | 401 | 认证失败/缺 header/token 过期 | 凭据配置错误，不重试，告警 |
| 1210/1213/1214/1215 | 400 | 参数错误 | 不重试，记日志 |
| 1211 | 400 | 模型不存在 | 路由层修正模型名（如 glm-5.3flash → glm-5.3-flash） |
| 1212 | 400 | 模型不支持该调用方式 | 端点/协议错配（如对 coding 端点用错路径） |
| 1261 | 400 | Prompt 超长 | 触发压缩/截断，不换模型 |
| 1301 | 400 | 内容安全 | 不重试，提示用户改写 |
| — | 500 | 内部错误/1200/1230/1234 | 通用重试（有限次） |

> 插件现有 retryOn 分类可直接以"HTTP 429 + 业务码"二元组做键：**1305→retry-same**、**1302→retry-queued**、**1308/1310/1316-1321→switch-credential（带重置时刻）**、**1113/1309/1314→switch-credential（永久）**、**1311→switch-model**、**401→config-error**、**400→no-retry**。

---

## 7. 与 RESEARCH 文档的对齐核对

| RESEARCH 断言 | 本次查证结果 |
|---|---|
| §一 "glm-5.3 文本、glm-5.3flash 套餐内支持图片" | ✅ 官方确认；flash 输入=图/视频/文件/文本，1M ctx |
| §五 场景表 vision → glm-5.3-flash | ✅ 套餐内唯一视觉对话模型；额度 ×3、价 1/10，是最优解 |
| §六.3 pi-ai base64 发图接受度 | ✅ 官方支持 Base64 Data URL（≤5M、≤6000×6000、jpg/png/jpeg） |
| §六.7 flash 与默认模型分属不同账号 | ✅ Key 分类制（标准/套餐互不通用）使双 key 归因天然清晰 |
| §9.2 生成=工具能力、理解=模型路由 | ✅ 生成模型不在套餐、独立端点按次计费，必须工具内实现 + 标准 key |
| §9.3 reasoningEffort 先于换模型 | ✅ low/high/max 三档 + Coding Plan 容错映射，安全可用 |
| 关卡 1 图片准入（DSH 侧） | （本次不涉及 DSH 源码；GLM 侧无额外障碍——flash 原生收图） |

---

## 8. 引用清单

**bigmodel.cn（智谱开放平台，国内）**
- 套餐概览（模型/积分/系数/非高峰）：https://docs.bigmodel.cn/cn/coding-plan/overview.md
- 使用须知（并发/风控/封禁）：https://docs.bigmodel.cn/cn/coding-plan/usage-notes.md
- API Key 分类管理（端点 vs 计费）：https://docs.bigmodel.cn/cn/coding-plan/notice/api-key-management.md
- 常见问题（1113 根因/耗尽不透支/MCP 额度）：https://docs.bigmodel.cn/cn/coding-plan/faq.md
- 如何切换模型（[1m] 后缀、/effort 映射、Cline 图片勾选）：https://docs.bigmodel.cn/cn/coding-plan/latest-model.md
- 接入工具（指定工具清单）：https://docs.bigmodel.cn/cn/coding-plan/tool/others.md
- 视觉理解 MCP：https://docs.bigmodel.cn/cn/coding-plan/mcp/vision-mcp-server.md
- GLM-5.3 模型页：https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3.md
- GLM-5.3-Flash/FlashX 模型页：https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash.md
- GLM-4.6V 模型页：https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4.6v.md
- GLM-4.6V-Flash（免费）：https://docs.bigmodel.cn/cn/guide/models/free/glm-4.6v-flash.md
- 模型概览：https://docs.bigmodel.cn/cn/guide/start/model-overview.md
- API 定价：https://docs.bigmodel.cn/cn/guide/start/pricing.md
- 深度思考（thinking/reasoning_effort/映射）：https://docs.bigmodel.cn/cn/guide/capabilities/thinking.md
- 思考模式（交错/保留/轮级）：https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode.md
- 对话补全 API（image_url/video_url/file 参数 schema）：https://docs.bigmodel.cn/api-reference/模型-api/对话补全.md
- 错误码：https://docs.bigmodel.cn/cn/api/api-code.md
- 速率限制：https://docs.bigmodel.cn/cn/api/rate-limit.md
- GLM-Image：https://docs.bigmodel.cn/cn/guide/models/image-generation/glm-image.md
- CogView-4：https://docs.bigmodel.cn/cn/guide/models/image-generation/cogview-4.md
- CogVideoX-3：https://docs.bigmodel.cn/cn/guide/models/video-generation/cogvideox-3.md

**z.ai（国际）**
- Pricing（USD）：https://docs.z.ai/guides/overview/pricing.md
- GLM-5.3-Flash（EN，Coding Plan 3× quota / off-peak 50%）：https://docs.z.ai/guides/vlm/glm-5.3-flash.md
- Errors（码表与国内一致）：https://docs.z.ai/api-reference/api-code.md
- 文档首页（"Plans from $18/month"）：https://docs.z.ai/
- 订阅页（JS 渲染，数字未能核实）：https://z.ai/subscribe

**GitHub**
- zai-org/GLM-V（GLM-4.6V/4.5V/4.1V-Thinking 开源权重）：https://github.com/zai-org/GLM-V
- zai-org/CogView：https://github.com/THUDM/CogView
- zai-org/CogVideo（CogVideoX）：https://github.com/THUDM/CogVideo

## 9. 未证实 / 待实测清单

1. z.ai 国际套餐的 Lite/Pro/Max 积分数字 —— 订阅页 JS 渲染，静态抓取不可得 **[未证实]**。
2. 套餐 Key 直调 CogView-4/GLM-Image 的实际报错码（预期 429/1311 或 400/1211）—— 需真实 key 实测 **[未证实]**。
3. glm-5.3-flash 图片输入的 token 折算规则（每图折多少输入 token）—— 官方文档未给出数字，费用估算只能按"积分公式 + 实际 usage 返回" **[未证实]**。
4. DSH 以 OpenAI 兼容姿态接入 coding 端点是否被平台按"指定工具"放行 —— 平台侧工具识别机制未公开；需实测（当前 RESEARCH 记录显示用户已在 DSH 中正常消耗套餐额度，属正向信号但非官方承诺）。
5. 团队版权益的具体席位/额度数字（team.md 未抓取，个人版已覆盖本插件需求）。
