# dsh-model-failover

> DeepSeek Harness 插件：多供应商 / 多账号模型自动替补切换。额度用完自动换号，任务不中断。零运行时依赖。

**状态**：M1 已实现并通过 11 项自动化测试。完整设计见 [DESIGN.md](DESIGN.md)。

## 核心能力（已实现，M1）

- ✅ 可实现性已验证：基于 DSH `agent/request` + `agent/request-error` 瀑布，进程内完成"失败→换号→重试"闭环
- 多供应商（DeepSeek / GLM / 任意 OpenAI 兼容）+ 同供应商多账号（如 GLM×3）
- 用户自定义替补顺序（YAML 配置数组即顺序）
- 额度用尽（402/余额不足）、限流（429）、鉴权失效自动冷却并切换下一棒
- 冷却自动恢复（默认 30 分钟），全链路日志可观测
- 近零依赖：运行时仅依赖官方 schema 库 @deepseek-ai/schemastery（本身零依赖），其余只依赖 DSH 公开插件契约；监听器全程防御式降级，插件任何异常都会透传，等价于未安装

## 安装

在 DSH 的插件管理器中安装 npm 包 dsh-model-failover。安装后把账号池配置写进 cordis.patch.yml（patch 层配置在 DSH 升级后保留）。

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

```bash
node --import ./test/loader.mjs --test ./test/index.test.mjs
```

测试使用 Node 内置 test runner 与一个 schemastery 测试桩，零 devDependencies。

## Roadmap

- [x] M1：Config 账号池 + 双瀑布监听 + 错误分类 + 冷却状态机 + 日志 + 测试
- [ ] M2：llm.registerConfigurableProviders 注册 glm-1/2/3 条目，设置页可发现；agentDefaultModel 联动
- [ ] M3（可选）：Web UI 管理替补顺序与账号健康状态
- [ ] M4（可选）：用量统计与额度预警

## License

MIT
