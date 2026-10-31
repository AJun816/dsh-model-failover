---
name: Bug 报告
about: 插件行为异常
title: "[bug] "
labels: bug
body:
  - type: input
    id: version
    attributes:
      label: 插件版本
      placeholder: "0.8.4"
    validations:
      required: true
  - type: input
    id: dsh
    attributes:
      label: DSH 版本
    validations:
      required: true
  - type: textarea
    id: what
    attributes:
      label: 发生了什么 / 期望是什么
    validations:
      required: true
  - type: textarea
    id: logs
    attributes:
      label: DSH 日志中 model-failover: 前缀的行
      description: 复现时打开 DSH 日志面板搜索 model-failover
      render: shell
  - type: textarea
    id: config
    attributes:
      label: 相关配置（脱敏，勿贴 API Key）
      render: yaml
