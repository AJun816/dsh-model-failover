# Security Policy

## 支持版本

仅支持最新发布版本（见 [CHANGELOG.md](CHANGELOG.md)）。

## 安全边界（设计承诺）

- 插件**不**产生子进程、**不**发起自定义网络请求、**不**读取环境变量；
- 写入仅限：本插件自己的 settings 命名空间、DSH 官方凭据库（经通用 RPC）、插件目录下的 `switches.log`；
- API Key 只进 DSH 加密凭据库，从不落盘到插件自己的文件、不进日志。

## 报告漏洞

请勿公开开 issue。通过 GitHub Security Advisories（仓库 Security 标签页 → Report a vulnerability）私密报告，或在 issue 里留下联系方式由维护者联系你。会在 72 小时内响应。
