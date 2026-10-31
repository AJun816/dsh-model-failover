# dsh-model-failover

> DeepSeek Harness 插件：多供应商 / 多账号模型自动替补切换。额度用完自动换号，任务不中断。零运行时依赖。

**状态**：已实现并通过 25 项自动化测试（CI：Node 22/24）。完整设计见 [DESIGN.md](DESIGN.md)。

## 核心能力（已实现，M1）

- ✅ 可实现性已验证：基于 DSH `agent/request` + `agent/request-error` 瀑布，进程内完成"失败→换号→重试"闭环
- 多供应商（DeepSeek / GLM / 任意 OpenAI 兼容）+ 同供应商多账号（如 GLM×3）
- 用户自定义替补顺序（YAML 配置数组即顺序）
- 额度用尽（402/余额不足）、限流（429）、鉴权失效自动冷却并切换下一棒
- 冷却自动恢复（默认 30 分钟），全链路日志可观测
- 近零依赖：运行时仅依赖官方 schema 库 @deepseek-ai/schemastery（本身零依赖），其余只依赖 DSH 公开插件契约；监听器全程防御式降级，插件任何异常都会透传，等价于未安装

## 安装

在 DSH 的插件管理器（设置 → 插件 → 添加插件）中，输入以下任一安装源：

| 安装源 | 输入内容 | 说明 |
|---|---|---|
| GitHub SSH（推荐） | `git@github.com:AJun816/dsh-model-failover.git` | 走 SSH 免密，大陆网络无代理也稳定 |
| GitHub HTTPS | `https://github.com/AJun816/dsh-model-failover` | 需网络能直连 GitHub（或系统代理开启） |
| npm 包名 | `dsh-model-failover` | 需先发布到 npm（或镜像源同步后） |
| 本地目录 | `~/projects/dsh-model-failover` | 开发调试用，必须是绝对路径 |

安装说明：

- 大陆网络推荐 SSH 形式（`git@github.com:...`）：安装预检与克隆都走 SSH 密钥，不依赖代理。HTTPS 形式在直连被墙且无代理时会超时失败。
- 中国大陆用户可在安装引导中选择 npmmirror 镜像源，依赖（`@deepseek-ai/schemastery`）会从镜像拉取。
- 通过 GitHub 安装的插件更新方式：先卸载再安装新版。
- **v0.3.0 起带 GUI**：设置 → 插件 页面出现 "Model Failover 模型替补" 卡片，可直接编辑替补分组/条目顺序/冷却时长/触发类别，保存即时生效；也可继续手改 `cordis.patch.yml`。
- **多账号（v0.6.0）**：卡片直接识别系统已配置的供应商；点「复制」只需填一把新 API Key，即为同一供应商加一个账号（如 GLM × 3）。Key 写入 DSH 加密凭据库，配置克隆自动完成，副本自动插到替补链原账号之后；支持换 Key 与删除。纯通用 RPC（`settings.mutate` / `credentials.set`），DSH 升级不易破坏。运行状态看 DSH 日志中 `model-failover:` 前缀的行。
- 安装后把账号池配置写进 `cordis.patch.yml`（patch 层配置在 DSH 升级后保留），并重启或重载插件。
- 插件配置键为 `model-failover`（cordis 插件名），与包名 `dsh-model-failover` 略有不同，属正常现象。

### 兼容性说明

- 插件只依赖 DSH 的公开插件契约：`agent/request` / `agent/request-error` 瀑布、`ctx.effect`、`ctx.logger`、`llm` 服务、`settings`/`credentials` 通用 RPC、`appendPluginRecord` 会话记录通道与插件管理器卡片插槽；所有监听器全程防御式降级（任何异常等价于未安装），DSH 升级后即使个别通道变化，插件也只是安静地失去该通道，不会报错或阻塞任务。
- 切换日志默认写在插件安装目录下的 `switches.log`（随安装方式自动定位，不依赖机器路径）。
- GUI 卡片需要宿主挂载 `remote.llm` / `remote.credentials` 服务（当前版本 DSH 均已挂载）；仅使用老版 DSH 时卡片可能不出现，但宿主侧的自动替补功能不受影响。

## 快速开始

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

说明：

- `entries` 数组顺序即替补顺序；条目里的 `provider` 是 DSH 中已注册的 provider 名（例如为 GLM 三个账号各自配置的 provider 条目），`model` 是该 provider 下的模型 id。
- `activeGroup` 激活后，每次模型调用的路由由本插件接管：按顺序选第一个健康条目。
- 触发切换的错误分类（`retryOn`）：`quota`（402/余额不足/QUOTA/ACCOUNT_QUOTA）、`rate-limit`（429）、`auth`（401/403）、`network`。其他错误（如上下文超长）不换号，保持 DSH 原生行为。
- 某账号失败后进入账号级冷却（默认 30 分钟，到期自动恢复；若供应商返回更长的 Retry-After 则按更长者）；冷却是账号级（同账号所有模型联动）、跨会话共享的。所有账号都在冷却时不再干预，交回 DSH 默认错误处理。
- 与内置 llm-retry 插件协同：本插件的 request-error 监听以 prepend 注册、总是先冷却账号再委托下游，因此 llm-retry 的退避/延迟决策完整保留；仅当下游无恢复决策且存在健康替补时才由本插件返回 retry。
- 同一 turn/step 内的重试次数以组大小为上限（每个账号最多一次机会），杜绝重试风暴。
- 供应商宕机/过载（503/504/529）按 network 分类处理；跨供应商切换时仅保留 maxTokens/temperature 等中立字段，避免用 A 家凭证调 B 家。
- 配置变更由 DSH 插件生命周期自动重载（cordis 重新调用 apply，监听器随旧 fiber 一并销毁重建）。

## 开发与测试

源码为 TypeScript（`src/index.ts`，类型引用官方 `@deepseek-ai/dsh-llm` 契约），`tsc` 编译产物 `lib/` 直接提交进仓库——DSH 从 GitHub 安装时无需任何构建步骤，发布物保持零构建依赖。

```bash
pnpm build    # tsc 编译到 lib/
pnpm test     # 编译 + 18 项测试（Node 内置 test runner + schemastery 测试桩）
```

运行时依赖仅 `@deepseek-ai/schemastery`；TypeScript 与官方类型包只在 devDependencies。

## Roadmap

- [x] M1：Config 账号池 + 双瀑布监听 + 错误分类 + 冷却状态机 + 日志 + 测试
- [x] M3（v0.3.0）：设置 → 插件 页 GUI 卡片（分组/条目编辑、拖动排序按钮、冷却与触发类别设置，保存即时生效，走通用 settings RPC，无需自定义 Host API）
- [ ] M3+：GUI 内展示各账号实时冷却状态（需自定义 Remote 服务）
- [ ] M2：llm.registerConfigurableProviders 注册 glm-1/2/3 条目，设置页可发现；agentDefaultModel 联动
- [ ] M4（可选）：用量统计与额度预警

## License

MIT
