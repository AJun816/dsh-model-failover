# dsh-model-failover

[![CI](https://github.com/AJun816/dsh-model-failover/actions/workflows/ci.yml/badge.svg)](https://github.com/AJun816/dsh-model-failover/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-4D6BFE.svg?style=flat-square)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.9.0-4D6BFE.svg?style=flat-square)](CHANGELOG.md)

> **DeepSeek Harness（DSH）多供应商 / 多账号模型自动替补插件** —— 额度用尽、限流、鉴权失败时自动切换到下一个账号，任务不中断。零第三方运行时依赖，全程防御式降级：插件任何异常都等价于未安装。
>
> **v0.9.0 起一仓双插件**：本仓库同时携带 [dsh-glm-suite](packages/glm-suite)（GLM Coding Plan 套餐四 MCP 完整封装：`web_search`/`web_fetch` 后端切换 + `glm_zread_*` + `glm_vision_*` 原生工具 + 多 key 池轮换）。**一次安装 = 两个插件同时生效**，详见下方[「第二个插件：dsh-glm-suite」](#第二个插件dsh-glm-suiteglm-coding-plan-四件套)。

## 它解决什么问题

- 手里有多把 Key（GLM×3、DeepSeek×2、任意 OpenAI 兼容端点），但额度/限流一炸任务就断；
- 想要"429 → 自动换号 → 继续跑"，而不是人工盯着重启；
- 希望插件在 DSH 升级后依然可用，而不是每个版本都坏一次。

## 特性

- 🔁 **请求级故障转移**：挂在 DSH 公开的 `agent/request` / `agent/request-error` 双瀑布上，失败 → 冷却账号 → 换下一棒 → 立即重试，全程进程内完成，零代理、零外部进程
- 🧭 **自动模式**：不配置任何分组时，自动把系统里已配置的全部 provider 组成替补链（注册顺序）
- 🧊 **账号级冷却**：默认 30 分钟自动恢复；供应商返回更长 Retry-After 时按更长者；冷却跨会话共享
- 🛡️ **重试风暴防护**：同一 turn/step 的替补跳数以组大小为上限；全员冷却时做 5 分钟节流的"二次机会"探测（可能已充值）
- 🎯 **目录兜底**：组内账号耗尽时，可回退到组外任一健康 provider（`fallbackToCatalog`，默认开）
- 🖼️ **GUI 卡片**：设置 → 插件 → "Model Failover 模型替补"，可视化编辑分组/顺序/冷却/触发类别，一键"复制"为同供应商加账号（Key 进 DSH 加密凭据库），最近切换横幅
- 📡 **可观测**：DSH 日志 `model-failover:` 前缀行、插件目录 `switches.log`（JSONL）、会话记录（`plugin:model-failover/switch`，官方 ignorable 通道）、卡片横幅
- 🪶 **近零依赖**：运行时仅 `@deepseek-ai/schemastery`；只使用 DSH 公开插件契约
- 🔗 **一仓双插件（v0.9.0）**：随包附带 dsh-glm-suite —— GLM 套餐搜索/网页读取/开源仓库/视觉理解四 MCP 原生化，多 key 池轮换，装一个仓库全带上

## 安装

> v0.9.0 起下表任一安装源装完即**同时**得到 model-failover 与 dsh-glm-suite 两个插件（root 依赖 `file:packages/glm-suite` + 根 patch 双行插入）。只要替补、不要 GLM 网络接管的用户见[退出 GLM 接管](#退出-glm-接管只要-failover)。

在 DSH 的插件管理器（设置 → 插件 → 添加插件）中输入以下任一安装源：

| 安装源 | 输入内容 | 说明 |
|---|---|---|
| GitHub HTTPS（推荐） | `https://github.com/AJun816/dsh-model-failover` | 任何能访问 GitHub 的网络均可 |
| GitHub SSH | `git+ssh://git@github.com/AJun816/dsh-model-failover.git` | 走 SSH 免密，大陆网络无代理也稳定 |
| npm 包名 | `dsh-model-failover` | 需先发布到 npm（或镜像源同步后） |
| 本地目录 | `~/projects/dsh-model-failover` | 开发调试用，必须是绝对路径 |

说明：

- 大陆网络推荐 SSH 形式（`git+ssh://git@github.com/AJun816/dsh-model-failover.git`）：克隆走 SSH 密钥，不依赖代理。**不要用 `git@github.com:...` 简写** —— pnpm 会把它误解析成名为 "git" 的本地 link 依赖而安装失败。
- 中国大陆用户可在安装引导中选择 npmmirror 镜像源，依赖（`@deepseek-ai/schemastery`）会从镜像拉取。
- GitHub/npm 安装的插件更新方式：先卸载再安装新版。
- 安装后把账号池配置写进 `cordis.patch.yml`（patch 层配置在 DSH 升级后保留），或直接用 GUI 卡片配置（即时生效）。
- 插件配置键为 `model-failover`（cordis 插件名），与包名 `dsh-model-failover` 略有不同，属正常现象。

## 第二个插件：dsh-glm-suite（GLM Coding Plan 四件套）

`packages/glm-suite` 是完整的独立 DSH 插件（也可单独拆出安装），把 GLM Coding Plan 的套餐能力一网打尽：

| 套餐能力 | 接入方式 | 亮点 |
|---|---|---|
| 联网搜索 `web_search_prime` | `web_search` 后端替换（provider `zhipu-official`） | 多 key 池 + 1310/1308 重置时刻冷却；≈1 积分/次，不花 DeepSeek 的钱 |
| 网页读取 `webReader` | `web_fetch` 后端替换（provider `zhipu-reader`） | 池耗尽自动本地 http 兜底，web_fetch 永不死 |
| 开源仓库 `zread` | `glm_zread_search_doc / repo_structure / read_file` 三件原生工具 | 仓库文档/结构/源码调研走套餐积分 |
| 视觉理解 `@z_ai/mcp-server` | `glm_vision_*` 八件原生工具（懒 spawn 本地子进程） | 识图/OCR/错误截图诊断/图表解读/UI diff/视频理解；配额触顶自动换号重启 |

**多 key 轮换**是两个社区 GLM 插件都没有的能力：`apiKeyEnvs`（默认三把 `ZAI_CODING_CN*` 凭据引用）顺序即优先级，窗口类错误（1310/1308 等）解析重置时刻自动冷却、欠费/过期永久标记、参数类错误不轮换直接失败。搜索池全耗尽时显式报错（含各 key 重置时刻），**绝不静默回落 DeepSeek 计费**。

详细文档：[packages/glm-suite/README.md](packages/glm-suite/README.md) ｜ 调研与实测记录：[research/glm-mcp-for-dsh.md](research/glm-mcp-for-dsh.md)

### 退出 GLM 接管（只要 failover）

在你的用户层 patch（`~/.dsh/profiles/<profile>/cordis.patch.yml`）追加，后写覆盖插件层：

```yaml
- id: glm-suite
  disabled: true
- id: web
  config:
    searchProvider: deepseek-official
    fetchProvider: http
```

## 快速开始

### 方式 A：零配置（自动模式）

安装后默认启用自动发现：系统里配置过的 provider 自动组成替补链（注册顺序），额度/限流失败即自动换号。打开 DSH 日志看到 `model-failover: active group "auto" ...` 即生效。

### 方式 B：手动分组（YAML）

```yaml
# cordis.patch.yml
model-failover:
  groups:
    - id: glm-pool
      entries:
        - { provider: glm-1, model: glm-4.7 }
        - { provider: glm-2, model: glm-4.7 }
        - { provider: glm-3, model: glm-4.7 }
  activeGroup: glm-pool
  cooldownMinutes: 30
```

或直接在 GUI 卡片里编辑——两种方式等价，GUI 保存即时生效。

## 配置参考

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `groups` | `{ id, entries: [{ provider, model }][] }[]` | `[]` | 替补分组；`entries` 数组顺序即替补顺序。为空且 `autoDiscover` 开启时走自动链 |
| `activeGroup` | string | 第一组 | 当前激活的分组 id；未命中回退第一组 |
| `cooldownMinutes` | number | `30` | 账号冷却分钟数（供应商 Retry-After 更长时按更长者） |
| `retryOn` | string[] | `[quota, rate-limit, auth, network]` | 触发切换的错误类别；其他错误保持 DSH 原生行为 |
| `autoDiscover` | boolean | `true` | 无分组时自动把已配置 provider 组成替补链 |
| `fallbackToCatalog` | boolean | `true` | 组内耗尽时回退到组外任一健康 provider |
| `lastSwitches` | record[] | `[]` | 最近切换记录（宿主写入、卡片展示，勿手改） |

字段语义详见下节；`provider` 是 DSH 中已注册的 provider 名（多账号即为同供应商配置的多个 provider 条目），`model` 是该 provider 下的模型 id。

## 切换语义

**错误分类**（代码 → HTTP 状态 → 消息关键词逐级判定）：

| 类别 | 触发示例 |
|---|---|
| `quota` | 402 / 余额不足 / QUOTA / ACCOUNT_QUOTA / "insufficient balance" / 13xx 系 quota 码 |
| `rate-limit` | 429 / RATE_LIMIT / "too many requests" / 1302 |
| `auth` | 401 / 403 / 无效 Key |
| `network` | 503 / 504 / 529 / TIMEOUT / CONNECTION / "fetch failed" / 服务繁忙 |
| `other` | 其余（如上下文超长）—— **不切换**，保持 DSH 原生行为 |

**行为规则**：

- **冷却**：失败账号进入账号级冷却（同账号所有模型联动），默认 30 分钟自动恢复；Retry-After 更长则延长；冷却是内存态、跨会话共享。
- **立即切换**：存在健康替补时直接返回重试决策（不等内置 llm-retry 的退避延迟）；无替补时不干预，交回 DSH 默认处理。
- **与内置 llm-retry 协同**：本插件以 prepend 注册、总是先冷却账号再委托下游——llm-retry 的退避决策完整保留；仅当下游无恢复决策且存在健康替补时才由本插件接管一次跳转。
- **重试预算**：同一 turn/step 的替补跳数 ≤ 组大小 + 兜底小预算，杜绝风暴。
- **二次机会**：全员冷却时，每 provider 每 5 分钟放行一次探测（可能已充值），用真实请求验证。
- **中立字段**：跨供应商切换只保留 `maxTokens` / `temperature` 等中立字段，避免 A 家参数/凭证打到 B 家。
- **配置热更新**：GUI 保存或改 YAML 后由 DSH 生命周期自动重载（监听器随旧 fiber 销毁重建），账号冷却状态保留。

## GUI 卡片手册

设置 → 插件 → **Model Failover 模型替补**：

- **自动模式**：显示按注册顺序的预览链；点"从目录生成"可固化为可编辑分组
- **分组编辑**：增删条目、上下移动调整顺序、从模型目录选择 provider/model
- **多账号**：在条目上点"复制"——只需填一把新 API Key，插件自动克隆 provider 配置、写入 DSH 加密凭据库、把副本插到原账号之后；支持换 Key 与删除
- **高级策略**：冷却时长、触发类别开关
- **最近切换**：卡片顶部横幅展示最近 5 次切换（来源 → 目标、原因、时间）

## 可观测性

| 通道 | 位置 | 内容 |
|---|---|---|
| DSH 日志 | DSH 日志面板 `model-failover:` 前缀 | 激活分组、每次切换、降级原因 |
| 切换日志 | 插件目录 `switches.log` | 每次切换一行 JSON（时间/来源/目标/原因/路径） |
| 会话记录 | 会话日志 `plugin:model-failover/switch` | 官方 ignorable 通道，不参与模型上下文，任何版本 DSH 均可安全读取 |
| 卡片横幅 | `lastSwitches`（settings 命名空间） | 最近 5 次切换 |

## 兼容性与升级策略

- 只依赖 DSH **公开插件契约**：`agent/request` / `agent/request-error` 瀑布、`ctx.effect`、`ctx.logger`、`llm` 服务、`settings` / `credentials` 通用 RPC、`appendPluginRecord` 会话记录通道、插件管理器卡片插槽。
- **防御式降级承诺**：所有监听器与记录通道全程 best-effort——任何异常（包括未来 DSH 升级导致某个通道变化）都会安静降级，等价于插件未安装，绝不阻塞任务、绝不可能写坏会话日志（会话记录只走自动标记 `ignorable` 的官方通道，且有防回退守卫测试）。
- 切换日志默认写在插件安装目录下（随安装方式自动定位，不依赖机器路径）。
- GUI 卡片的"多账号复制"需要宿主挂载 `remote.llm` / `remote.credentials` 服务（当前版本 DSH 均已挂载）；老版 DSH 上卡片可能不出现，但宿主侧自动替补不受影响。

## 故障排查

**安装失败 / 装出个叫 "git" 的包** —— 用了 `git@github.com:...` 简写。改用完整 URL：`https://github.com/AJun816/dsh-model-failover` 或 `git+ssh://git@github.com/AJun816/dsh-model-failover.git`。

**装了但不切换** —— 依次检查：① DSH 日志有无 `model-failover: active group ...`（无则配置未被读取）；② 错误类别是否在 `retryOn`；③ 是否全员冷却中（日志会写 second-chance / giving up）；④ 失败的 provider 是否在替补链里。

**卡片不出现** —— 老版 DSH 未挂载 `remote.llm` / `remote.credentials`。宿主侧功能不受影响，升级 DSH 即可。

**会话历史加载失败（"unknown to this harness and not marked ignorable"）** —— v0.8.1 之前版本写坏的日志。修复：

```bash
python3 scripts/repair-session-log.py --dry-run   # 先扫描
python3 scripts/repair-session-log.py             # 修复（自动备份到 ~/.dsh/session-repair-backups/）
```

**更新插件** —— 非官方渠道插件请先卸载再安装新版。

## 架构概览

```
agent/request      ──▶ [prepend] 选第一个健康条目 ──▶ 改写 provider/model（仅保留中立字段）
       ▲                                                        │
       │ { kind: 'retry' }（立即换号）                          ▼ 失败
       │                                                agent/request-error
       └────────── 冷却账号 · 分类 · 预算/二次机会/兜底 ◀── [prepend] 总是委托下游
```

完整设计推演（双瀑布可行性验证、与 llm-retry 的组合分析、每个决策的源码依据）见 [DESIGN.md](DESIGN.md)。

## 开发与测试

```bash
pnpm install
pnpm build    # tsc 编译到 lib/（产物随仓库提交，安装端零构建）
pnpm test     # 28 项测试（Node 内置 test runner + schemastery/dsh-session 测试桩）
```

贡献指南、代码规范（公开契约 / 防御式 / 无机器特定路径 / 防回退守卫）与发布流程见 [CONTRIBUTING.md](CONTRIBUTING.md)；版本历史见 [CHANGELOG.md](CHANGELOG.md)。

## Roadmap

- [x] 双瀑布故障转移 + 错误分类 + 冷却状态机 + 测试
- [x] GUI 卡片（分组编辑 / 多账号复制 / 最近切换横幅）
- [x] 自动发现 + 目录兜底 + 二次机会探测
- [x] 会话记录官方通道化 + 防回退守卫 + 日志修复工具
- [ ] GUI 内展示各账号实时冷却状态
- [ ] 用量统计与额度预警

## License

MIT © AJun816

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
