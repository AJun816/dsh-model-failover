#!/usr/bin/env node
/**
 * e2e-diagnose.mjs — 复现生产"一直切换失败"场景的诊断脚本。
 *
 * 场景 100% 取自 2026-11-15 生产环境 (~/.dsh):
 *   - 分组 main：zai-coding-cn/glm-5.3 → minimax-cn/M3.1-Flash（仅 2 棒）
 *   - cooldownMinutes: 3（用户配置，极短）
 *   - activeGroup: glm-pool（不存在的分组 id —— 配置漂移）
 *   - zai-coding-cn 持续 TIMEOUT（网络超时）
 *   - minimax-cn 持续 rate_limit_error "已达到 Token Plan"（无重置时间戳）
 *   - DSH 0.2.2 固定路由架构（agent.model.select 存在）
 *
 * 模拟 90 分钟（仿真时钟，10s 步进），统计：
 *   - 每个账号被探测（复活后又失败）的次数 = 用户可见失败次数
 *   - 全员冷却 fail-fast 次数
 *
 * 用法: node scripts/e2e-diagnose.mjs [--expect-thrash|--expect-bounded]
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-failover-diagnose-'))
const logFile = join(process.env.DSH_HOME, 'switches.log')

const { apply } = await import('../lib/index.js')

// ---- 最小宿主桩 ----------------------------------------------------------
function makeCtx() {
  const listeners = new Map() // waterfall -> [fns] (index 0 = 最外层/prepend)
  return {
    llm: { listProviders: () => [], listModels: async () => [] },
    on(name, fn, opts) {
      const list = listeners.get(name) ?? []
      if (opts?.prepend) list.unshift(fn); else list.push(fn)
      listeners.set(name, list)
      return () => { const l = listeners.get(name); const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1) }
    },
    effect(fn) { this._dispose = fn() },
    logger: { info() {}, warn() {} },
    listeners,
  }
}

async function dispatch(ctx, name, payload, base) {
  const list = ctx.listeners.get(name) ?? []
  const run = (i) => i >= list.length ? base() : list[i](payload, () => run(i + 1))
  return run(0)
}

// ---- 生产配置与故障（照抄 ~/.dsh/profiles/*/cordis.patch.yml 与 switches.log）
const PROD_CONFIG = {
  groups: [{ id: 'main', entries: [
    { provider: 'zai-coding-cn', model: 'glm-5.3' },
    { provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash' },
  ]}],
  activeGroup: 'glm-pool', // 不存在的 id（生产配置漂移）
  cooldownMinutes: 3,
  retryOn: ['quota', 'rate-limit', 'auth', 'network'],
  autoDiscover: true, fallbackToCatalog: false, catalogExclude: ['workbuddy-ai', 'workbuddy-cn'],
}
const FAILURES = {
  'zai-coding-cn': { code: 'TIMEOUT', message: 'Request timed out.' },
  'minimax-cn': { code: 'RATE_LIMIT', status: 429, message: '已达到 Token Plan 使用上限，请稍后再试。' },
}

// ---- 仿真 ----------------------------------------------------------------
const clock = { t: 1794745600000 }
const ctx = makeCtx()
apply(ctx, PROD_CONFIG, { now: () => clock.t, logFile })

const selection = { provider: 'zai-coding-cn', model: 'glm-5.3' }
const agent = {
  id: 'diag-agent', session: { id: 'diag-session' },
  model: {
    select: (s) => { Object.assign(selection, s) },
    current: () => selection,
  },
}
const payloadOf = () => ({ agent, provider: selection.provider, turn: 1, step: Math.floor(clock.t / 10000) })

const stats = { probes: {}, failFast: 0, switches: [] }
const STEP_MS = 10_000, RUN_MS = 90 * 60_000
for (; clock.t < 1794745600000 + RUN_MS; clock.t += STEP_MS) {
  // pre-step：宿主准备本步路由
  await dispatch(ctx, 'agent/pre-step', payloadOf(), async () => ({ kind: 'enter' }))
  // 本步请求：当前选中的账号注定失败（生产场景：全部真死）
  const before = selection.provider
  await dispatch(ctx, 'agent/request-error', { ...payloadOf(), failure: FAILURES[selection.provider] }, async () => undefined)
  if (selection.provider !== before) {
    stats.switches.push({ atMin: Math.round((clock.t - 1794745600000) / 60000), from: before, to: selection.provider })
    // 切换目标若在本步内即失败（下一步），计为一次"探测失败"= 用户可见失败
    stats.probes[before] = (stats.probes[before] ?? 0)
  } else {
    stats.failFast++
  }
  // 下一步立刻失败：被切到的账号 10s 后失败 → 计入该账号探测
  // （在循环下一轮 request-error 处统计）
}
// 统计每账号被"复活后即失败"的次数：直接从 switches.log 读 second-chance
import { readFileSync } from 'node:fs'
const logLines = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
const secondChance = logLines.filter(r => r.via === 'second-chance')
const chainSwitches = logLines.filter(r => r.via === 'chain' && r.from !== r.to)

console.log('=== dsh-model-failover 生产场景诊断（90 分钟仿真） ===')
console.log(`账号探测失败(second-chance 次数 = 用户可见失败): ${secondChance.length}`)
const per = {}
for (const r of secondChance) per[r.to] = (per[r.to] ?? 0) + 1
console.log('  按账号:', JSON.stringify(per))
console.log(`链内切换次数: ${chainSwitches.length}`)
console.log(`全员冷却 fail-fast 步数: ${stats.failFast}`)
console.log(`配置漂移检查: activeGroup='${PROD_CONFIG.activeGroup}' 与分组 id [main] 不匹配`)

const mode = process.argv[2] ?? ''
if (mode === '--expect-thrash') {
  const thrash = secondChance.length > 10
  console.log(thrash ? '结论: ❌ 复现"一直切换失败"——探测风暴（>10 次/90 分钟）' : '结论: ✅ 未复现探测风暴')
  process.exitCode = thrash ? 1 : 0
} else if (mode === '--expect-bounded') {
  const bounded = secondChance.length <= 8
  console.log(bounded ? '结论: ✅ 探测有界（≤8 次/90 分钟，指数退避生效）' : '结论: ❌ 探测仍过于频繁')
  process.exitCode = bounded ? 0 : 1
}
rmSync(process.env.DSH_HOME, { recursive: true, force: true })
