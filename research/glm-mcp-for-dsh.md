# GLM Coding Plan MCP × DSH 接入调研报告

> 调研日期：2026-11-01 ｜ 调研人：lead（DSH Team Lead）
> 背景：用户持有 GLM Coding Plan（3 把 key），套餐自带搜索等 MCP 能力，但 DSH 里 web_search 一直走 DeepSeek 官方搜索（按量扣钱，且当前 402 余额不足）。目标：**让 DSH 的联网搜索/网页读取/仓库调研全部吃 GLM 套餐积分，不再花 DeepSeek 的钱**。
> 方法：本地考古（旧插件 + profile 组态）→ 联网调研（官方文档 + DSH 插件市场目录 + 社区插件 README）→ **真实 key 实测**（initialize / tools/list / tools/call 全链路）。

---

## 0. TL;DR（硬结论）

1. **你之前确实写过一个对口的插件**：~/.dsh/plugins/dsh-web-search-zhipu（2026-08-26，v0.1.0）。它把 GLM 套餐专属的 web_search_prime 远程 MCP 注册为 DSH ctx.web 缝的搜索后端——思路完全正确，**今天实测协议仍然 100% 兼容**（工具名 web_search_prime 没变、双层数字编码返回格式没变、SSE/JSON 混合响应没变）。
2. **它"无法正常使用"的根因不是代码，是从来没被挂载**：desktop profile（~/.dsh/profiles/desktop/package.json）的 dependencies 和 dsh.profile.bundles 里都没有它，也没有 - id: web 行把 searchProvider 钉到 zhipu-official。DSH 的 web 缝规则是"恰好一个可用 provider 才自动选"，而 base bundle 永远带 deepseek-official，所以不 pin 就永远轮不到它。
3. **联网调研找到两个现成的社区插件**（都在 DSH 官方插件市场目录里）：
   - **deepseek-harness-zhipu_plan_tools** v0.1.8（magian1127）：智谱 MCP **三件套**——接管 web_search（web_search_prime）+ web_fetch（webReader）+ 可选注册 3 个 github_* 仓库工具（zread）。engines 门禁 >=0.2.0-rc.2 <0.3.0-0，本机桌面版 **0.2.1-rc.5 兼容**。
   - **dsh-web-search-zai** v0.2.0（kenny2077）：仅搜索，但支持 Coding Plan MCP / REST API 双计费模式 + 中英文设置卡片 + z.ai 国际/智谱国内双端点。
   - **两个都不支持多 key 轮换**——而这正是你（3 把 key、7 天上限各不相同）的刚需，也是你的 model-failover 插件能力的天然延伸。
4. **实测（2026-11-01，真实 key）**：key1（ZAI_CODING_CN_API_KEY）搜索 MCP 报 1310 已达到 7 天使用上限（2026-11-05 17:10:49 后恢复）；key2（ZAI_CODING_CN_2_API_KEY）**搜索/网页读取/zread 全部跑通**。→ 单 key 接入会在任意一把 key 触顶时静默失效退回 DeepSeek，**多 key 轮换是刚需**。
5. 成本事实：MCP 搜索约 **1 积分/次**（套餐 5 小时池：Lite 2000 / Pro 12000 / Max 28000，非高峰 5 折）；REST API 模式 0.05 元/次。对比 DeepSeek 搜索按量计费——这就是"省 DeepSeek 钱"的量化来源。

---

## 1. 旧插件考古：dsh-web-search-zhipu

**位置**：~/.dsh/plugins/dsh-web-search-zhipu（未进 git，单机存在）

**架构（代码审计结论：质量高，可复活）**：

- 挂 DSH **官方 web 能力缝**：cordis 插件 name='web-search-zhipu'、inject=['web']，ctx.web.registerSearchProvider(new ZhipuSearchProvider(...))，provider id zhipu-official——与官方 dsh-web-search-deepseek/-perplexity/-exa 完全同构。
- 直连 https://open.bigmodel.cn/api/mcp/web_search_prime/mcp（streamable HTTP MCP）：initialize → notifications/initialized → tools/call，session-id 复用 + 过期透明重初始化。
- 凭据：复用 ZAI_CODING_CN_API_KEY credential reference（与 GLM 聊天路由同 key，DSH 凭据服务 → 启动环境 → 字面量三层解析）。
- 防御性完备：SSE/JSON 双格式解析、Zhipu 业务错误信封（{code, msg} 非 jsonrpc）识别、query 截断 70 字符、URL 去重映射到缝的 WebSearchResult。

**实测兼容性（2026-11-01 curl 复刻插件的完整调用链）**：

| 检查项 | 结果 |
|---|---|
| initialize（带 key） | 通过：serverInfo mcp-web-search-prime 0.0.1，mcp-session-id 36 字符 |
| tools/list | 通过：工具名仍是 **web_search_prime**（官方文档页写成 webSearchPrime 是展示名；实际 MCP 工具名没改，旧插件不用改） |
| 参数 schema | 通过：search_query（70 字上限）+ content_size（medium 约 400-600 字 / high 约 2500 字）+ search_recency_filter（oneDay/oneWeek/oneMonth/oneYear/noLimit）；**新增** search_domain_filter（域名白名单）与 location（cn/us）——旧插件未用，可作增强 |
| tools/call（key2） | 通过：真实搜索结果，双层 JSON 编码格式与旧插件 decodeWebSearchPrime 解码逻辑逐字匹配 |
| 无鉴权探测 | 通过：端点活着，{code:1001, msg:未收到 Authorization}——正是旧插件 #isBusinessError 处理的形态 |

**三个缺口（复活/升级时要补）**：

1. **单 key**：只支持一个 apiKeyEnv。任一 key 触 1310（7 天上限）即整体失效。需要 key 池 + 1310 冷却（解析"YYYY-MM-DD HH:MM:SS 后可继续使用"设冷却到该时刻）+ 1113/1309 快速失败。
2. **仅搜索**：没有 webReader（web_fetch 后端）、没有 zread、没有视觉。
3. **package.json 没声明依赖**：@deepseek-ai/schemastery / dsh-credentials / dsh-launch-environment / dsh-web 全靠 profile node_modules 向上解析（碰巧能找到），挂载为 profile 依赖前应显式声明（参照 dsh-model-failover 的做法）。

**为什么一直没生效**：对比 ~/.dsh/profiles/desktop/package.json ——dsh-model-failover 三处齐全（dependencies / bundles / patch 行），而 dsh-web-search-zhipu 三处全缺。插件的 cordis.patch.yml 只定义了自己的 insert 行，还缺 - id: web 的 searchProvider: zhipu-official 钉选。

---

## 2. 联网调研：现成插件与官方能力

### 2.1 GLM Coding Plan 官方 4 个专属 MCP（docs.bigmodel.cn，2026-11 现状）

| MCP | 形态 | 端点 / 启动 | 工具（实测 schema） | 本机实测 |
|---|---|---|---|---|
| 联网搜索 | 远程 streamable HTTP | https://open.bigmodel.cn/api/mcp/web_search_prime/mcp（SSE 变体 /sse?Authorization=KEY） | web_search_prime(search_query, content_size, search_recency_filter, search_domain_filter, location) | key2 通过；key1 1310 触顶 |
| 网页读取 | 远程 streamable HTTP | https://open.bigmodel.cn/api/mcp/web_reader/mcp | webReader(url) → 标题+正文+元数据 | key2 通过，返回全文 |
| 开源仓库 zread | 远程 streamable HTTP | https://open.bigmodel.cn/api/mcp/zread/mcp | search_doc(repo_name, query, language)、read_file(repo_name, file_path)、get_repo_structure(repo_name, dir_path) | key2 通过（vitejs/vite 目录返回；私有/未索引仓库报 repo not found） |
| 视觉理解 | **本地 stdio** | npx -y @z_ai/mcp-server，env Z_AI_API_KEY（+ Z_AI_MODE=ZHIPU） | ui_to_artifact / extract_text_from_screenshot / diagnose_error_screenshot / understand_technical_diagram / analyze_data_visualization / ui_diff_check / image_analysis / video_analysis | 未实测（需本地 npx 拉包） |

注：Claude Code 场景下搜索/读取/识图由服务端内置，其他 MCP 客户端（含 DSH）按上表自接。**DSH 不在官方"指定工具"清单**（条款灰区，见第 5 节）。

### 2.2 DSH 侧的两条官方接入面

1. **ctx.web 能力缝（推荐给搜索/读取）**：ctx.web.registerSearchProvider() / registerFetchProvider + profile patch 钉选。模型看到的工具名不变（web_search/web_fetch），后端换成智谱——**不增加工具目录、不改变模型行为、系统提示零污染**。base bundle 默认：searchProvider: deepseek-official、fetchProvider: http（packages/bundle/base/cordis.patch.yml）。
2. **@deepseek-ai/dsh-mcp-client（推荐给 zread/视觉）**：官方 MCP 客户端桥，一条 patch 行挂一个服务器，工具以 mcp__<serverName>__<tool> 注册（desktop profile 已用它挂 mcp-playwright，是现成先例）。支持 stdio 与 streamable-http（headers 可用 !!js 从 process.env 取值）。**局限**：新增工具膨胀工具目录；headers 拿不到 DSH 凭据服务的 key（只能走启动环境变量）；没有 key 轮换。

### 2.3 社区现成插件对比

| 维度 | deepseek-harness-zhipu_plan_tools v0.1.8 | dsh-web-search-zai v0.2.0 | 你的 dsh-web-search-zhipu v0.1.0 |
|---|---|---|---|
| 作者/更新 | magian1127，约 2026-10-19 | kenny2077，2026-09 实测成本 | 本人，2026-08-26 |
| 搜索（web_search_prime） | 接管 web_search，含提示替换 | 接管，MCP/REST 双模式 | 有（未挂载） |
| 网页读取（webReader） | 接管 web_fetch，关闭时回退本地 http | 无 | 无 |
| zread（github_* 工具） | 可选（默认关）github_search_doc / github_get_repo_structure / github_read_file | 无 | 无 |
| 设置卡片 | 六字段，live 生效 | 中英双语 | 有（settings 命名空间） |
| 凭据 | ZAI_CODING_CN_API_KEY（三层解析，与 GLM 聊天同 key） | ZAI_API_KEY（可复用） | ZAI_CODING_CN_API_KEY |
| 多 key 轮换 | 无 | 无 | 无 |
| engines | >=0.2.0-rc.2 <0.3.0-0（本机 0.2.1-rc.5 兼容） | 未声明 | — |
| 桌面版安装 | 明确支持（README 给了 desktop 手动挂载步骤） | 面向 web profile | 未挂载 |

**调研结论**：生态里**没有**"GLM MCP + 多 key 轮换"的现成插件。搜索/读取/zread 三件套已被 zhipu_plan_tools 覆盖且维护活跃、版本门禁匹配——**最快路径是直接装它**；但要在"3 把 key、各打各的 7 天上限"的现实下 100% 不断供，要么给它提 PR/issue 加 key 池，要么把你的旧插件升级成"三件套 + key 池"（与 model-failover 共享冷却哲学）。

---

## 3. 三条接入路线（按落地速度排序）

### 路线 A：安装 deepseek-harness-zhipu_plan_tools（最快，今天可用）

桌面版 profile 被桌面应用独占，dsh plugin CLI 拒绝 --profile desktop，需手动挂载：

1. 完全退出 DeepSeek Harness 桌面应用；
2. 编辑 ~/.dsh/profiles/desktop/package.json：dependencies 加 "deepseek-harness-zhipu_plan_tools": "^0.1.8"，dsh.profile.bundles 数组末尾追加同名条目（官方 bundle 保持原样）；
3. cd ~/.dsh/profiles/desktop && pnpm install；
4. 启动应用 → 设置 → 插件 → 智谱三件套卡片：确认 credentialRef 为 ZAI_CODING_CN_API_KEY、开启搜索/读取（zread 可选）；
5. 验证：对话里让它"联网搜索 xxx"，DSH 日志应出现智谱 MCP 请求而非 DeepSeek 搜索计费。

**已知短板**：单 key。key1 现在 1310 触顶（11-05 17:10 恢复）——装完先把 credentialRef 切到 ZAI_CODING_CN_2_API_KEY（凭据库里三把都在），或等 key1 恢复。

### 路线 B：复活 + 升级你自己的 dsh-web-search-zhipu（差异化，根治多 key）

改造清单（工作量约半天）：

1. **挂载**：补 profile 三件套（dependencies file:/Users/ajun/.dsh/plugins/dsh-web-search-zhipu、bundles 追加、patch 加 - id: web 行钉 searchProvider: zhipu-official）；package.json 显式声明依赖。
2. **key 池**：apiKeyPool = [ZAI_CODING_CN_API_KEY, ZAI_CODING_CN_2_API_KEY, ZAI_CODING_CN_3_API_KEY]；命中 1310/1308（含重置时刻文本）→ 该 key 冷却到重置时刻 + 换池内下一把（照搬 model-failover 的冷却池实现）；1113/1309 → 永久冷却。注意 MCP 错误形态：业务错误包在 result.content[0].text = MCP error -429: {"error":{"code":"1310"...}}、isError: true 里，解析点在 WebError 抛出前。
3. **webReader provider**：同构加一个 registerFetchProvider（zhipu-reader），web_fetch 后端可选切智谱（JS 渲染页/反爬场景比本地 http 强；纯静态页保留本地 http 省积分）。
4. **新参数**：透传 location（cn/us）与 search_domain_filter；content_size 已有。
5. （可选）zread 三工具经 ctx.tools.register 注册或单独 mcp-client 行（见路线 C）。

### 路线 C：原生 dsh-mcp-client 直接挂远程 MCP（零代码，适合 zread/视觉）

照抄已有的 mcp-playwright 行型（key 需在启动环境变量里，mcp-client 的 headers 只吃 process.env）：

    # cordis.patch.yml
    - id: mcp-zread
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: zread
        transport: streamable-http
        url: https://open.bigmodel.cn/api/mcp/zread/mcp
        headers:
          Authorization: !!js "Bearer undefined"

    - id: mcp-zai-vision            # 本地视觉 MCP（8 个视觉工具）
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: zai-vision
        transport: stdio
        command: npx
        args: ["-y", "@z_ai/mcp-server@latest"]
        env:
          Z_AI_API_KEY: !!js process.env.ZAI_CODING_CN_2_API_KEY
          Z_AI_MODE: ZHIPU

工具以 mcp__zread__search_doc 等名字出现。**不建议**用这条路挂搜索：会把 mcp__web__web_search_prime 加进工具目录，与内置 web_search 重复、膨胀上下文，模型还可能选错。

---

## 4. 推荐最终形态（100% 吃套餐）

- 对话模型：glm-5.3（zai-coding-cn/-2/-3 三号 failover 池，已就绪）
- web_search 后端：智谱 web_search_prime（套餐积分，约 1 分/次）—— 路线 A 或 B
- web_fetch 后端：默认本地 http（免费）；难抓页面手动用 webReader —— B 或手动
- 仓库调研：zread（mcp__zread__*，套餐积分）—— 路线 C
- 视觉：glm-5.3-flash（模型路由，已有）+ 可选 @z_ai/mcp-server —— RESEARCH-AUTO-MODEL-SWITCH 六章 + C
- DeepSeek 搜索计费：彻底退出回路（DEEPSEEK_API_KEY 仅留聊天/兜底）

## 5. 风险与合规

- **条款灰区**：GLM Coding Plan 官方"指定工具"清单（Claude Code/Codex/Cline/Cursor 等 23 个）不含 DSH；条款写明"仅限指定工具使用，用于非支持工具将被限制权益"，多次违规有封号风险（详见 research/team/glm-capabilities.md 2.4 节）。本机已长期用 DSH 消耗套餐额度属正向信号但非官方承诺，自担风险。
- **1310 触顶形态**：MCP 内嵌 code:1310 + "已达到 7 天使用上限，2026-11-05 17:10:49 后可继续使用"——插件的错误分类器要按此解析；套餐耗尽不透支，等周期重置。
- **搜索也吃积分**：MCP 搜索即使不带聊天推理也扣积分（约 1 分/次）；高频搜索场景留意 5 小时池。

## 6. 引用

- 官方：[联网搜索 MCP](https://docs.bigmodel.cn/cn/coding-plan/mcp/search-mcp-server.md) | [网页读取 MCP](https://docs.bigmodel.cn/cn/coding-plan/mcp/reader-mcp-server.md) | [开源仓库 MCP](https://docs.bigmodel.cn/cn/coding-plan/mcp/zread-mcp-server.md) | [视觉理解 MCP](https://docs.bigmodel.cn/cn/coding-plan/mcp/vision-mcp-server.md) | [套餐概览/积分](https://docs.bigmodel.cn/cn/coding-plan/overview.md) | [错误码](https://docs.bigmodel.cn/cn/api/api-code.md)
- 社区：[magian1127/deepseek-harness-zhipu_plan_tools](https://github.com/magian1127/deepseek-harness-zhipu_plan_tools) | [kenny2077/dsh-web-search-zai](https://github.com/kenny2077/dsh-web-search-zai)（1 积分/次与 0.05 元/次的实测出处）| [DSH 插件市场目录](https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json)
- 本地：~/.dsh/plugins/dsh-web-search-zhipu/（旧插件源码）| ~/.dsh/profiles/desktop/package.json + cordis.patch.yml（组态证据）| packages/web/web/（web 缝 schema：searchProvider/fetchProvider 钉选语义）| packages/mcp/mcp-client/（原生 MCP 客户端）

## 7. 实测记录存档（2026-11-01，Asia/Shanghai）

| # | 调用 | key | 结果 |
|---|---|---|---|
| 1 | web_search_prime/mcp initialize（无鉴权） | — | 1001 未收到 Authorization（端点活） |
| 2 | initialize + tools/list | key1 | 会话建立；工具 web_search_prime |
| 3 | tools/call web_search_prime | key1 | 失败：1310 已达到 7 天使用上限，2026-11-05 17:10:49 后可继续使用 |
| 4 | tools/call web_search_prime（GLM-5.3） | key2 | 通过：5+ 条真实结果（z.ai blog、HF 等） |
| 5 | tools/call webReader（docs.bigmodel.cn 文档页） | key2 | 通过：标题+全文 |
| 6 | tools/call get_repo_structure（vitejs/vite） | key2 | 通过：目录树 |
| 7 | 旧插件 node test.js 独立跑 | — | 失败仅因插件目录未装依赖（node_modules 缺），非代码问题 |


---

## 8. 覆盖度结论与完整封装（2026-11-01 补充）

### 8.1 旧插件覆盖度研究结论

| 套餐能力 | 旧 dsh-web-search-zhipu v0.1.0 | 缺口判定 |
|---|---|---|
| 联网搜索 web_search_prime | 覆盖，但单 key、无 1310 处理 | 多 key 轮换缺失（3 把 key 各自 7 天上限，单 key 必断供） |
| 网页读取 webReader | **完全缺失** | web_fetch 仍走本地 http（免费但抓不动 JS 渲染/反爬页） |
| 开源仓库 zread | **完全缺失** | 仓库调研无套餐通道 |
| 视觉理解 @z_ai/mcp-server | **完全缺失** | 8 个专项视觉工具不可用（flash 对话视觉已有） |
| 新参数（location/search_domain_filter） | 未透传 | 搜索区域偏好不可配 |

结论：**旧插件只发挥了套餐约 1/4 的 MCP 能力**，且在 key 触顶时静默失效。

### 8.2 封装产物：dsh-glm-suite v0.1.0（~/.dsh/plugins/dsh-glm-suite）

架构：官方 ctx.web 缝 provider 替换（搜索/读取）+ ctx.tools 原生工具注册（zread 三件）+ KeyPool 多 key 轮换。

| 能力 | 实现 | 验证（2026-11-01 真 key） |
|---|---|---|
| 搜索 web_search_prime | provider zhipu-official，多 key + 1310/1308 重置时刻冷却 + 1113/1309/1313/1000-1003 永久标记 | 冒烟：key1 触 1310 → 自动冷却(至 2026-11-05 17:15:49+08) → 换 key2 → 8 条真实结果 |
| 网页读取 webReader | provider zhipu-reader，池耗尽本地 http 兜底（30s/4MB/3跳/200k 字符） | 冒烟：文档页 55,696 字符全文 |
| 开源仓库 zread | glm_zread_search_doc / glm_zread_repo_structure / glm_zread_read_file 原生工具 | 冒烟：vitejs/vite 目录树 |
| 视觉 MCP | README 附官方 dsh-mcp-client stdio 挂载行（架构边界：本地进程归官方客户端管） | 未实测（npx 本地拉包） |
| 失败语义 | 搜索池全耗尽 → 显式 WEB_PROVIDER_UNAVAILABLE（含各 key 重置时刻），**绝不回落 DeepSeek 计费** | — |
| 可观测 | armed 心跳 + 每次轮换日志（对齐 model-failover 的 armed 可观测教训） | — |
| apply 级集成（test/integration.apply.test.mjs） | 桩 ctx 驱动真实 apply()：T1-T3 双 provider+三工具注册、T4 armed 心跳、T5/T6 available、T7 经 apply 的搜索全链路（9 条真实结果）、T8 webReader 全链路、T9 zread execute 全链路、T10 卸载无异常 | **10/10 PASS**（2026-11-01 20:2x，真 key） |
| 质量 | 9 项纯逻辑单测全过；全部模块 node --check 通过；profile 内 import 验证通过 | — |

宿主生效判据（待重启）：桌面应用日志目录为 ~/Library/Logs/DeepSeek Harness（已确认当前无 glm-suite 行，主进程 10-31 23:52 启动未重启）；重启后应出现 T4 同款心跳 `glm-suite: armed ...`。|

挂载：已写入 desktop profile（dependencies + bundles + pnpm install 完成），**重启桌面应用生效**。

关键修正记录：旧插件代码里的 settingsCtx.settings.installSection() 在 0.2.x 源码中不存在（从未被加载所以从未暴露）——新插件移除该块，配置面改由框架从 Config schema 自动派生。

### 8.3 逃逸缺陷登记（验收协议第六条）

| 编号 | 缺陷 | 出生原因 | 命中计数 | 转化 |
|---|---|---|---|---|
| E1 | pnpm `file:` 依赖为拷贝而非链接：首轮 install 后的源码修复（index.js 移除 installSection）未进 profile node_modules；二轮 install 因 npmmirror 拉可选原生依赖失败未刷新拷贝 | 拷贝语义 + 镜像源抖动掩盖静默不更新 | 1（2026-11-01，验收 A2 首查命中） | 固化为断言 A2：每次 install/改码后 cmp 10 文件字节一致；遗留风险：未来任何 pnpm install 后需复查 |

