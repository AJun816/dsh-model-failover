# 贡献指南（Contributing）

感谢关注 dsh-model-failover！这是一个以**升级韧性（DSH 升级不坏）**与**绝对安全（绝不阻塞任务、绝不写坏会话日志）**为第一原则的 DSH 插件。

## 开发环境

```bash
git clone https://github.com/AJun816/dsh-model-failover.git
cd dsh-model-failover
pnpm install
pnpm build     # tsc -> lib/ + esbuild -> lib/client.js
pnpm test      # 28 项测试（Node 内置 test runner；test/loader.mjs 提供 schemastery/dsh-session 测试桩）
pnpm typecheck # tsc --noEmit
```

> 注意：CI 与本地测试直接调用 `node --import ./test/loader.mjs --test ./test/index.test.mjs`，避免 pnpm 包装器的依赖状态检查干扰。

## 仓库结构

```
src/index.ts      宿主侧：双瀑布监听、错误分类、冷却池、切换记录（全部防御式）
src/client.tsx    浏览器侧：插件管理器卡片（SettingsForm + 官方 slots）
lib/              编译产物（随仓库提交——安装端零构建）
test/             测试 + 模块桩（schemastery-stub / dsh-session-stub / hook）
scripts/          build-client.mjs；repair-session-log.py（旧版日志修复工具）
cordis.patch.yml  插件配置 patch 层（dsh.bundle.patch）
```

## 代码规范（评审必查项）

这些规范来自一次独立审计 agent 对照 DSH 源码的核验，是本插件"DSH 升级不坏"的根基：

1. **只用公开契约**：`agent/request` / `agent/request-error` 瀑布、`ctx.effect`、`ctx.logger`、`llm` 服务、`settings` / `credentials` 通用 RPC、`appendPluginRecord`、插件管理器插槽。禁止触达 harness 内部/私有 API。
2. **会话记录只走官方通道**：类型必须符合 `plugin:` 语法（`plugin:model-failover/switch`），禁止任何直接事件写入调用——**测试套件里有防回退守卫，违规会 fail**。
3. **全程防御式降级**：任何监听器异常必须等价于"插件未安装"（透传 / 原样传播下游错误 / 绝不重复 `next()`）；fire-and-forget 路径必须 `.catch()` 兜底。
4. **无机器特定路径**：任何默认路径必须从 `import.meta.url` 或运行时推导。
5. **结构化类型**：对 harness 类型只用 type-only 导入 + 本地接口切片 + 运行时可选链，禁止值依赖（动态 import 的官方通道除外，且必须可降级）。
6. **发布物零构建**：`lib/` 必须随仓库提交且与 `src/` 同步；`files` 字段保持最小。

## 提交与发布

- 提交信息：`类型: 摘要`（如 `fix: ...` / `feat: ...` / `docs: ...`），版本发布提交带 `vX.Y.Z: ...` 前缀。
- 发布流程：改动 → 测试全绿 → 更新 CHANGELOG.md → `package.json` 版本号 → 重编译并同步 `lib/` → 提交 → 打 tag（`git tag -a vX.Y.Z -m "..." `）→ push（含 tag）。
- 行为变化必须在 CHANGELOG 的对应版本段落写清楚动机。

## 报告问题

请使用 issue 模板（bug 报告附 DSH 日志中 `model-failover:` 前缀的行与插件版本）。安全问题见 [SECURITY.md](SECURITY.md)。
