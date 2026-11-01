# dsh-glm-suite —— GLM Coding Plan 套餐能力完整封装

> 一个插件吃满 GLM Coding Plan 的 3 个专属远程 MCP：**联网搜索、网页读取、开源仓库**。
> 多 key 轮换（1310/1308 窗口触顶自动换号、重置时刻自动恢复），搜索链路**绝不回落 DeepSeek 计费**。
> DSH ≥0.2.0-rc.2 <0.3.0（桌面版 0.2.1-rc.5 实测）。

## 套餐能力覆盖矩阵

| 套餐能力 | 形态 | 本插件 | 说明 |
|---|---|---|---|
| GLM-5.3 / GLM-5.3-Flash 对话 | 模型路由 | —（已由 llm-pi-ai providers 承担） | flash 兼具视觉对话 |
| 联网搜索 web_search_prime | 远程 MCP | ✅ `web_search` 后端 → provider `zhipu-official` | 多 key 轮换 + 1310 冷却；≈1 积分/次 |
| 网页读取 webReader | 远程 MCP | ✅ `web_fetch` 后端 → provider `zhipu-reader` | 池耗尽自动本地 http 兜底，web_fetch 不死 |
| 开源仓库 zread | 远程 MCP | ✅ `glm_zread_search_doc` / `glm_zread_repo_structure` / `glm_zread_read_file` 三件原生工具 | 套餐积分；私有/未索引仓库会报 repo not found |
| 视觉理解 @z_ai/mcp-server | 本地 stdio MCP | ✅ `glm_vision_*` 八件原生工具（懒 spawn 本地子进程，key 池联动） | 实测识图 12s；配额与套餐同池（1310 自动换号重启子进程） |
| 图像/视频生成 | 标准 API 按次计费 | ❌ 不在套餐内（1311），需标准 Key，非本插件范围 | |

## 工作机制

- **搜索/读取 = provider 替换**：注册进 DSH 官方 `ctx.web` 缝；模型看到的工具名不变（`web_search`/`web_fetch`），后端换成智谱 MCP。bundle patch 把 `web` 行的 `searchProvider`/`fetchProvider` 钉到本插件。
- **zread = 原生工具**：经 `ctx.tools.register` 注册（JSON Schema 参数 + text 输出 + generic 卡片），与内置工具零冲突；`zread: false` 时执行期显式报 ZHIPU_DISABLED。
- **vision = 本地 stdio MCP 桥**：懒 spawn `npx -y @z_ai/mcp-server@latest`（首次调用才启动，不拖累宿主），8 件 `glm_vision_*` 工具（schema 实测自 v0.1.5 服务器；官方文档的 image_analysis/video_analysis 实际名为 analyze_image/analyze_video）。key 池联动：配额类错误冷却换号并自动重启子进程；视觉服务器把 429/1310 包在普通错误文本里的形态已适配。
- **多 key 池**：`apiKeyEnvs` 顺序即优先级。业务码分类（bigmodel 码表）：
  - `1310/1308/1314-1321`（窗口触顶）→ 解析消息里的重置时刻（Asia/Shanghai），冷却到该时刻 + 宽限（默认 5 分钟），自动换下一把；
  - `1302/1305`（并发/过载）→ 60 秒短冷却；
  - `1113/1309/1313/1000/1001/1003`（欠费/过期/鉴权）→ 永久标记；
  - 其余（参数/内容安全）→ 不轮换直接失败（换 key 也没用）。
- **失败语义**：搜索池全耗尽 → 显式 `WEB_PROVIDER_UNAVAILABLE`（错误消息含每把 key 的重置时刻）。**有意不回落 DeepSeek 搜索**——回落即回到按量计费，违背本插件目的。抓取池耗尽 → 本地受限 http 兜底（30s/4MB/3 跳/200k 字符）。
- **可观测**：启动心跳 `glm-suite: armed search=... fetch=... zread=... vision=... pool=... state=...`；每次轮换一行日志（哪把 key、什么码、冷却到何时）。armed 与否一眼可辨。
- **防御式降级**：所有注册/工具挂载 best-effort，任何异常等价于未安装；key 永不进日志/配置/错误。

## 安装（桌面版手动挂载）

桌面 profile 由桌面应用独占（`dsh plugin` CLI 拒绝 `--profile desktop`），手动三步：

1. 完全退出 DeepSeek Harness；
2. 编辑 `~/.dsh/profiles/desktop/package.json`：
   - `dependencies` 加 `"dsh-glm-suite": "file:/Users/ajun/.dsh/plugins/dsh-glm-suite"`
   - `dsh.profile.bundles` 末尾追加 `"dsh-glm-suite"`
3. `cd ~/.dsh/profiles/desktop && pnpm install`，启动应用。

（本机已完成以上挂载。）验证：DSH 日志出现 `glm-suite: armed ...`；对话里让它联网搜索，日志应出现智谱 MCP 请求与轮换记录，DeepSeek 不再被搜索计费。

## 配置（cordis.patch.yml 的 glm-suite 行）

| 键 | 默认 | 说明 |
|---|---|---|
| `search` | true | 接管 web_search 后端 |
| `fetch` | true | 接管 web_fetch 后端 |
| `zread` | true | 注册 glm_zread_* 三件工具 |
| `apiKeyEnvs` | 三把 ZAI_CODING_CN* | key 池（credential 引用名，顺序即优先级） |
| `contentSize` | medium | 搜索摘要：medium 400-600 字 / high 2500 字（积分更高） |
| `recencyFilter` | noLimit | oneDay/oneWeek/oneMonth/oneYear/noLimit |
| `location` | cn | 搜索区域偏好 cn/us |
| `cooldownGraceMinutes` | 5 | 窗口重置后的额外宽限 |
| `searchMcpURL`/`readerMcpURL`/`zreadMcpURL` | 官方端点 | 一般不动 |

注意：关闭 `search`/`fetch` 后 patch 的钉选仍在，web 工具会显式报 provider 不可用（不静默换回 DeepSeek）。要彻底还原 DeepSeek 搜索，卸载本插件（删 profile 两处条目 + pnpm install）。

## 视觉工具（glm_vision_*，v0.2.0 起原生）

无需任何手动挂载：`vision: true`（默认）即注册八件工具，首次调用自动 spawn 本地 `@z_ai/mcp-server`：

```
glm_vision_ui_to_artifact                 UI 截图 → 代码/提示词/设计规范/描述
glm_vision_extract_text_from_screenshot   截图 OCR（代码/终端/文档）
glm_vision_diagnose_error_screenshot      错误弹窗/堆栈截图诊断
glm_vision_understand_technical_diagram   架构图/流程图/UML/ER 解读
glm_vision_analyze_data_visualization     仪表盘/统计图表分析
glm_vision_ui_diff_check                  两张 UI 截图差异比对
glm_vision_analyze_image                  通用识图
glm_vision_analyze_video                  视频理解（MP4/MOV/M4V，本地 ≤8M）
```

- 图片支持本地路径与远程 URL；视频仅本地路径（MP4/MOV/M4V ≤8M）
- npx 不在宿主 PATH 时自动回退 /opt/homebrew/bin、/usr/local/bin 等常见位置；仍失败可在配置里给 `visionCommand` 绝对路径
- 实测（2026-11-01）：本地 400x225 PNG → analyze_image 12 秒返回准确中文描述（含 key1 1310 自动换号重启子进程全链路）

## 测试

```bash
node --test test/unit.test.mjs        # 9 项纯逻辑单测（无网络）
node test/smoke.mjs                   # 真 key 冒烟：搜索轮换 + reader + zread
node test/integration.apply.test.mjs  # apply() 全链路 10 断言（桩 ctx + 真 key）
node test/vision.smoke.mjs            # 视觉真调（本地图 → analyze_image）
```

## 合规提醒

GLM Coding Plan 官方"指定工具"清单不含 DSH，条款写明"仅限指定工具使用"；自担风险（详见 dsh-model-failover 仓库 research/team/glm-capabilities.md §2.4）。MCP 搜索 ≈1 积分/次，吃 5 小时池，非高峰 5 折。

## 与旧插件的关系

升级自 `~/.dsh/plugins/dsh-web-search-zhipu`（v0.1.0，仅搜索、单 key、从未挂载）。旧插件目录保留未动；本插件是它的完整继任（provider id `zhipu-official` 保持连续）。
