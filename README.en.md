# dsh-model-failover

[![CI](https://github.com/AJun816/dsh-model-failover/actions/workflows/ci.yml/badge.svg)](https://github.com/AJun816/dsh-model-failover/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-4D6BFE.svg?style=flat-square)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.8.4-4D6BFE.svg?style=flat-square)](CHANGELOG.md)

> **Automatic model & account failover plugin for DeepSeek Harness (DSH)** — when one account hits quota/rate-limit/auth errors, the next one takes over mid-task. Zero third-party runtime dependencies; every failure path degrades to "as if the plugin were not installed".

**Full user manual (Chinese): [README.md](README.md)** · Design notes: [DESIGN.md](DESIGN.md) · Changelog: [CHANGELOG.md](CHANGELOG.md)

## How it works

Hooks DSH's two public agent-loop waterfalls, entirely in-process (no proxy, no external process):

```
agent/request      ──▶ [prepend] pick first healthy entry ──▶ rewrite provider/model (neutral fields only)
       ▲                                                        │ failure
       │ { kind: 'retry' } (instant switch)                      ▼
       └────────── cool account · classify · budget/second-chance/fallback ◀── agent/request-error [prepend]
```

- **Account-level cooldown** (default 30 min, auto-recovery, honors longer Retry-After, shared across sessions)
- **Retry-storm guard**: hops per turn/step bounded by group size; 5-min-throttled second-chance probes when everyone is cooling
- **Catalog fallback**: when the group is exhausted, fall back to any other healthy configured provider
- **Composes with built-in llm-retry**: always delegates downstream first; only answers `{ kind: 'retry' }` when downstream has no recovery and a healthy alternative exists
- **Auto mode**: with no groups configured, every configured provider joins the chain automatically (registration order)
- **GUI card** (Settings → Plugins): visual group editing, one-click account duplication (API key goes into DSH's encrypted credential store), recent-switches banner

## Install

In DSH's plugin manager (Settings → Plugins → Add plugin), enter any of:

| Source | Input | Notes |
|---|---|---|
| GitHub HTTPS (recommended) | `https://github.com/AJun816/dsh-model-failover` | works wherever GitHub is reachable |
| GitHub SSH | `git+ssh://git@github.com/AJun816/dsh-model-failover.git` | SSH key auth; good without a proxy |
| npm | `dsh-model-failover` | after npm publish (mirrors sync automatically) |
| Local path | `~/projects/dsh-model-failover` | development; must be absolute |

Do **not** use the `git@github.com:...` scp shorthand — pnpm mis-parses it into a broken `link:` dependency. Update by uninstall + reinstall.

## Quick start

Zero-config auto mode works out of the box. For an explicit chain:

```yaml
# cordis.patch.yml
model-failover:
  groups:
    - id: glm-pool
      entries:
        - { provider: glm-1, model: glm-4.7 }
        - { provider: glm-2, model: glm-4.7 }
  activeGroup: glm-pool
  cooldownMinutes: 30
```

## Compatibility & safety

- Uses only public plugin seams: the two waterfalls, `ctx.effect`, `ctx.logger`, the `llm` service, generic `settings`/`credentials` RPCs, the official `appendPluginRecord` session-record channel, and the plugin-manager card slot.
- Session records are written **only** through the official ignorable channel (type `plugin:model-failover/switch`); a regression-guard test keeps it that way. The plugin cannot break session history on any DSH version.
- All listeners and recording channels are best-effort with full degradation — DSH upgrades at worst silently disable one channel, never a task.
- `scripts/repair-session-log.py` repairs logs damaged by pre-v0.8.1 versions (`--dry-run` to scan).

## Development

```bash
pnpm install && pnpm build && pnpm test   # 28 tests; compiled lib/ is committed — installs need no build
```

Guidelines and release flow: [CONTRIBUTING.md](CONTRIBUTING.md). MIT © AJun816.

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
