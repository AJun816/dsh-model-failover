# dsh-model-failover

> A DeepSeek Harness (DSH) plugin: automatic model & account failover across multiple providers. When one account's quota runs out, the next one takes over — the task never stops. Zero runtime dependencies.

**Status**: M1 implemented, 11 automated tests passing. Full design in [DESIGN.md](DESIGN.md) (Chinese).

## Key Features (implemented, M1)

- ✅ Feasibility verified against DSH source: built entirely on the `agent/request` + `agent/request-error` waterfalls — an in-process "fail → switch account → retry" loop with no external proxy
- Multi-provider (DeepSeek, GLM, any OpenAI-compatible endpoint) and multi-account per provider (e.g. GLM ×3)
- User-defined fallback order (the YAML array order is the failover order)
- Automatic switchover on quota exhaustion (402 / insufficient balance), rate limiting (429), and auth failures, with per-account cooldown
- Cooldown auto-recovery (default 30 minutes) and full log observability for every switch
- Zero third-party dependencies — depends only on public DSH plugin contracts, so DSH upgrades won't break it

## How It Works

```
step#3:  agent/request      → planner picks glm-1
         request fails      → 402 Insufficient Balance
         agent/request-error → glm-1 enters cooldown (30m)
         → returns { kind: "retry" }
step#3:  agent/request      → planner picks glm-2 → streams normally
```

The only DSH extension points used are the two public waterfall events plus
`llm.registerConfigurableProviders` and the `credentials` service. Every
listener degrades gracefully: if the plugin itself fails, it passes through
`next()` and DSH behaves exactly as if the plugin were not installed.

## Install

Install the npm package `dsh-model-failover` through the DSH plugin manager, then put your account pool into `cordis.patch.yml` (the patch layer survives DSH upgrades).

## Quick Start

```yaml
# cordis.patch.yml
model-failover:
  groups:
    - id: glm-pool
      entries:                      # array order = fallback order
        - { provider: glm-1, model: glm-4.7 }
        - { provider: glm-2, model: glm-4.7 }
        - { provider: glm-3, model: glm-4.7 }
    - id: cross-provider            # cross-vendor safety net
      entries:
        - { provider: deepseek, model: deepseek-chat }
        - { provider: glm-1, model: glm-4.7 }
  activeGroup: glm-pool
  cooldownMinutes: 30
  retryOn: [quota, rate-limit, auth, network]
```

## Roadmap

| Phase | Scope |
|---|---|
| M1 (MVP) | Host-only plugin: YAML account pool + the two waterfall listeners + failure classifier + cooldown state machine + logging. No UI. |
| M2 | Register `glm-1/2/3` via `llm.registerConfigurableProviders` so they appear in Settings; one-click default-model switch via `agentDefaultModel`. |
| M3 (optional) | Web UI: manage fallback order and per-account health / cooldown countdowns in a Settings slot. |
| M4 (optional) | Usage statistics (session-event projection) and low-quota alerts. |

## License

MIT
