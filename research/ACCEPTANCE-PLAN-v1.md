# 验收记录：PLAN-AUTO-MODEL-ROUTING.md v1.0

> 验收协议：用户 2026-11-01 注入版 ｜ 验收角色：lead（独立于研究员通道）
> 被验收物：最终实施方案 + 三份研究笔记 + RESEARCH 更新
> 验收时间：2026-11-01 19:40 (UTC+8) ｜ 结论：**通过**（0 失败 / 0 重试消耗）

## 断言清单（开工前置，含 1 红线）

| 编号 | 断言（可判定） |
|---|---|
| A1 | 三份笔记存在且引用密度达标（行号或 URL），含无法凭记忆编造的硬细节 |
| A2 | PLAN 含 §0–§8 完整结构与 M0–M4 分期验收表 |
| A3 | 关键技术断言抽 3 条由 lead 独立复核（源码直查 + 官方文档重抓） |
| A4 | §1.3 五处设计修正逐条可追溯到笔记证据并独立证实 |
| A5 | 工作区无越权变更（src/test/lib 零改动） |
| A6 🔴 | 方案主路径无被禁手段（猴补/外部代理/绕界面直调）；策略③确认弃用 |

## 自报作弊方式与设卡

| 作弊方式 | 设卡 | 结果 |
|---|---|---|
| 编造引用行号 | 抽样行号到 asar 解包源码逐条核对 | 未命中（L485/L2957/L422/L1953 全对） |
| 复述任务正文冒充研究 | 核查硬细节（错误码/积分系数/参数默认值）并与官方源交叉 | 未命中（7/7 错误码、clear_thinking 默认值均证实） |
| 越权改动 | git 全量审计 | 未命中（仅 4 文档新增 + RESEARCH 修改） |

## 验收表

| 断言编号 | 判定 | 证据位置 | 遗留风险 |
|---|---|---|---|
| A1 | ✅ 通过 | research/team/ 引用密度实测：dsh-impl-notes 64 处行号引用；glm-capabilities 47 处 URL；router-practices 43 处 URL | 无 |
| A2 | ✅ 通过 | PLAN-AUTO-MODEL-ROUTING.md L10-L247 标题结构 grep 实测（§0-§8、M0-M4 表齐全） | 无 |
| A3 | ✅ 通过 | ① remote getter：api-gateway client L485 defineProperty + remoteServiceKey L175/228（lead 直查 /tmp/dsh-extract2）；② 热更新链：pi-ai L2957 + cordis-plugin-loader L422（同上）；③ 请求级 effort：pi-ai L1953 resolveReasoningLevel(model, options.reasoningEffort ?? profile.reasoning)（同上）；④ 附加：GLM 错误码 1302/1305/1308/1310/1309/1311/1113 官方 api-code.md 重抓 7/7 命中 | 无 |
| A4 | ✅ 通过 | 修正1→impl-notes §1（remote.session.prompt 漏斗，源码级证实）；修正2→impl-notes §4（volatile 链 L2957/L422 证实）；修正3→impl-notes §5（L1953 证实）；修正4→RESEARCH §三/§九 + lead turn1 自证（工具结果直落 session log，不入 pre-step inbox）；修正5→glm-capabilities §3 + API 参数参考页证实（clear_thinking 默认 True，转写须显式 false） | 无 |
| A5 | ✅ 通过 | git status 实测：M RESEARCH / ?? PLAN / ?? research/，src、test、lib 零变更 | 无 |
| A6 🔴 | ✅ 通过 | PLAN L41-42（Non-goals 明禁）、L230（编译守卫）；策略③弃用见 RESEARCH L169；remote.session.prompt 包裹为白名单受控触点（指纹自检+仅失败介入+降级链） | 包裹属 C 级触点，DSH 客户端重构时需重适配（已在 PLAN §7 登记，金丝雀监控） |

## 防作弊三查

1. **测试/断言改动 vs 业务改动**：本单纯文档交付，无代码/测试改动（A5 证据）→ 不涉及
2. **通过是否来自标准被修改**：断言全部由验收角色本轮新写，未触碰任何既有标准 → 通过
3. **是否新增跳过或模拟**：无跳过/模拟；笔记中 5 项"未能核实"显式标注且均未被 PLAN 当作事实引用（z.ai 档位数字、Codex 配置细节等未出现在 PLAN）→ 通过

## 通道纪律

- 写操作仅经正规文件工具（write/edit）与既定团队流程；无资金类、无删除类操作
- 研究员写权限约束在各自笔记文件（A5 审计通过）

## 失败处置

- 无失败断言；A4 初查疑点（clear_thinking 未见于 thinking.md）经第二来源（API 参数参考页）复核转为通过，未消耗重试额度

## 逃逸沉淀（新断言入库）

| 新断言 | 出生原因 | 命中计数 |
|---|---|---|
| ACC-001：凡引用官方 API 参数的断言，独立复核必须覆盖"API 参数参考页"，不得仅查"能力说明页"（同一参数可能只定义在参考页） | 本轮 clear_thinking 首查 thinking.md 未命中，险些误判 A4 失败；实际定义在对话补全参数参考页 | 1 |
| ACC-002：标注[推断]的结论进入方案时，方案文本须保留推断标记或改为"证据链支持"，不得升格为官方明文 | PLAN §2.1"生成不走套餐额度"实为笔记[推断]级证据（证据链完整但非官方原文） | 1 |
