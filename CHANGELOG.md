# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow semver.

## [0.8.4] — 2026-10-31

### Added
- Regression-guard test: compiled output must contain zero direct required-event append calls; session records only via `appendPluginRecord` with the `plugin:` grammar.
- `scripts/repair-session-log.py`: scan + frame-faithful repair of session logs damaged by pre-0.8.1 versions (`--dry-run` to scan; backups to `~/.dsh/session-repair-backups/`).

## [0.8.3] — 2026-10-31

### Fixed — session-safety hardening
- Recording is fully fire-and-forget-safe (`.catch` on the note path): a switch can never become an unhandled host rejection.
- Plugin-record writer lookup caches success but retries after failure (a transient import failure no longer kills the channel until restart).
- A non-object downstream config passes through untouched instead of throwing inside `reroute()`.
- New regression tests: all-channels-fail switch; garbage-payload waterfalls.

## [0.8.2] — 2026-10-31

### Fixed — pre-publish audit (dedicated audit agent against DSH plugin standards)
- Dropped the machine-specific absolute switch-log default; the log now derives from `import.meta.url` next to `lib/` (works for git/npm/local installs and every user).
- `agent/request` routing failures now degrade to the resolved config instead of rethrowing; downstream errors still propagate unchanged.
- `agent/request-error` catch can no longer run `next()` twice (no duplicate llm-retry recovery).
- `ModelCatalog` interface gains `routableProviders` (matches the wire schema).
- Auto-chain preview now matches actual routing (registration order) instead of claiming default-model-first.
- Bounded the `inFlight` map; README test counts and local-path example fixed; compatibility notes added.

## [0.8.1] — 2026-10-31

### Fixed
- Session records moved to the official `appendPluginRecord` channel with type `plugin:model-failover/switch` (grammar-validated, envelope-marked `ignorable: true`). Previously the plain required-event append channel wrote an unknown event type, which the DSH persistence reader refuses to load ("unknown to this harness and not marked ignorable"), breaking history load for affected sessions.

## [0.8.0] — 2026-10-31

### Added
- Switch notices through three official channels: a session transcript event, a plugin JSONL switch log, and the `lastSwitches` advisory field rendered as a GUI banner.

## [0.7.0] — 2026-10-31

### Added / Changed
- Prepended `agent/request` listener (Default-model override fix), volatile-safe config reads, instant failover without llm-retry delay, catalog fallback, second-chance recharge probe.

## [0.5.0] — 2026-10-30

### Added
- Auto-discovery of configured providers as the default chain; native-style card redesign.

## [0.4.0] — 2026-10-30

### Added
- ui-primitives styling, model-catalog picker, duplicate-account helper.

## [0.3.0] – [0.3.4] — 2026-10-30

### Added
- Plugins-page GUI card editing fallback config over generic settings RPC; bundle patch declaration; client externals and module-loader fixes; volatile Config fields so the namespace is served with live effect-wired listeners.

## [0.1.0] – [0.2.x] — 2026-10-29

### Added
- M1: dual-waterfall failover, failure classifier, cooldown pool, retry budget, Retry-After support, llm-retry composition, neutral-field whitelist, TypeScript migration with committed `lib/`, 18 tests, CI.

[Unreleased]: https://github.com/AJun816/dsh-model-failover/compare/v0.8.4...HEAD
[0.8.4]: https://github.com/AJun816/dsh-model-failover/compare/v0.8.3...v0.8.4
[0.8.3]: https://github.com/AJun816/dsh-model-failover/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/AJun816/dsh-model-failover/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/AJun816/dsh-model-failover/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/AJun816/dsh-model-failover/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/AJun816/dsh-model-failover/compare/v0.5.0...v0.7.0
