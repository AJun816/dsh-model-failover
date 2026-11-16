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

const { apply, createPool, createCooldownStore } = await import('../lib/index.js')

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

// ---- 场景 B：账号额度到期（2026-11-16 事故）-----------------------------
// 生产现场：默认模型 deepseek-account/deepseek-flash 额度耗尽，插件把"链首"当成
// 失败账号去冷却，真正额度到期的账号从未被拉黑 → 选择原地不动、一直失败。
// 断言：冷却的必须是真正失败的账号，且下一条选择必须离开它。
async function checkQuotaExpiryHandoff() {
  const failures = []
  const CHAIN = { groups: [{ id: 'g', entries: [
    { provider: 'zai-coding-cn', model: 'glm-5.3' },
    { provider: 'zai-coding-cn-2', model: 'glm-5.3' },
  ] }], cooldownMinutes: 30 }
  const run = async (start, failureCode) => {
    const ctx = makeCtx()
    const { pool } = apply(ctx, CHAIN)
    const selection = { ...start }
    const agent = { id: 'quota-agent', session: { id: 'quota-session' }, model: {
      select: (s) => { Object.assign(selection, s) },
      current: () => selection,
    } }
    await dispatch(ctx, 'agent/pre-step', { agent, turn: 1, step: 1, modelSelection: selection }, async () => ({ kind: 'enter' }))
    await dispatch(ctx, 'agent/request', { agent, turn: 1, step: 1 }, async () => ({ ...start }))
    await dispatch(ctx, 'agent/request-error', { agent, turn: 1, step: 1, provider: start.provider, failure: { code: failureCode } }, async () => undefined)
    return { cooled: Object.keys(pool.snapshot()), selection }
  }
  // B1：手动选择链内第二棒后额度到期
  const b1 = await run({ provider: 'zai-coding-cn-2', model: 'glm-5.3' }, 'ACCOUNT_QUOTA')
  if (!b1.cooled.includes('zai-coding-cn-2')) failures.push('B1 未冷却真正失败的 zai-coding-cn-2（冷却了 ' + b1.cooled.join(',') + '）')
  if (b1.cooled.includes('zai-coding-cn')) failures.push('B1 误伤健康链首 zai-coding-cn')
  if (b1.selection.provider === 'zai-coding-cn-2') failures.push('B1 额度到期后仍停留在死号 zai-coding-cn-2')
  // B2：链外默认账号（deepseek-account）额度到期
  const b2 = await run({ provider: 'deepseek-account', model: 'deepseek-flash' }, 'ACCOUNT_QUOTA')
  if (!b2.cooled.includes('deepseek-account')) failures.push('B2 未冷却链外失败账号 deepseek-account')
  if (!CHAIN.groups[0].entries.some((e) => e.provider === b2.selection.provider)) failures.push('B2 额度到期后未交棒给替补链')
  return failures
}

// ---- 场景 C：重启后不重复踩已知死号（2026-11-16 14:28 事故）-----------
// 现场：14:27 重启 → 池被清空 → 14:28 撞 zai-1(14:32 恢复) → 切到 zai-2
// （11-17 才恢复）→ 用户下一条消息仍失败。期望：重启后预置已知重置时间，
// 预检直接离开已标记账号，落到可用账号（deepseek-account）。
async function checkRestartRecovery() {
  const failures = []
  const dir = mkdtempSync(join(tmpdir(), 'mf-diag-state-'))
  const CHAIN = { groups: [{ id: 'g', entries: [
    { provider: 'zai-coding-cn', model: 'glm-5.3' },
    { provider: 'zai-coding-cn-2', model: 'glm-5.3' },
    { provider: 'zai-coding-cn-3', model: 'glm-5.3' },
    { provider: 'deepseek-account', model: 'deepseek-flash' },
  ] }], cooldownMinutes: 3 }
  const clock = { t: Date.parse('2026-11-16T14:28:00+08:00') }
  const quota = (resume) => ({
    code: 'RATE_LIMIT', status: 429,
    message: '429: {"code":"1310","message":"已达到 7 天使用上限，' + resume + ' 后可继续使用。"}',
  })
  // 进程 A：三个 zai 账号先后撞 1310（周上限日期各不相同）
  const ctxA = makeCtx()
  const poolA = createPool({ cooldownMs: 3 * 60_000, now: () => clock.t, store: createCooldownStore({ directory: dir }) })
  apply(ctxA, CHAIN, { pool: poolA, now: () => clock.t, logFile: join(dir, 'switches.log') })
  const selection = { provider: 'zai-coding-cn', model: 'glm-5.3' }
  const agentA = { id: 'restart-agent', session: { id: 'restart-session' }, model: {
    select: (s) => { Object.assign(selection, s) }, current: () => selection,
  } }
  const failOnce = async (ctx, agent, resume) => {
    await dispatch(ctx, 'agent/request', { agent, turn: 1, step: 1 }, async () => ({ ...selection }))
    await dispatch(ctx, 'agent/request-error', { agent, turn: 1, step: 1, provider: selection.provider, failure: quota(resume) }, async () => undefined)
  }
  await failOnce(ctxA, agentA, '2026-11-16 14:32:13')
  await failOnce(ctxA, agentA, '2026-11-17 16:11:05')
  await failOnce(ctxA, agentA, '2026-11-17 16:11:05')
  if (selection.provider !== 'deepseek-account') {
    failures.push('C0 进程 A 未走到可用账号：' + selection.provider)
  }
  // 进程 B（重启）：同一 state 目录，全新池；当前选择停在 zai-coding-cn-2
  const ctxB = makeCtx()
  const poolB = createPool({ cooldownMs: 3 * 60_000, now: () => clock.t, store: createCooldownStore({ directory: dir }) })
  apply(ctxB, CHAIN, { pool: poolB, now: () => clock.t, logFile: join(dir, 'switches.log') })
  if (poolB.pendingReset('zai-coding-cn-2') <= clock.t) failures.push('C1 重启后丢失 zai-coding-cn-2 的重置时间')
  const selectionB = { provider: 'zai-coding-cn-2', model: 'glm-5.3' }
  const agentB = { id: 'restart-agent', session: { id: 'restart-session' }, model: {
    select: (s) => { Object.assign(selectionB, s) }, current: () => selectionB,
  } }
  await dispatch(ctxB, 'agent/pre-step', { agent: agentB, turn: 2, step: 1, modelSelection: selectionB }, async () => ({ kind: 'enter' }))
  if (selectionB.provider !== 'deepseek-account') {
    failures.push('C2 重启后的下一步仍停在已标记死号：' + selectionB.provider)
  }
  rmSync(dir, { recursive: true, force: true })
  return failures
}

// ---- 场景 D：替补链预检（0.12.0）--------------------------------------
// 一次失败后不逐个"试"：用 1-token 探针沿链验证，直接落到真正可用的账号。
async function checkProbeChain() {
  const failures = []
  const CHAIN = { groups: [{ id: 'g', entries: [
    { provider: 'zai-coding-cn', model: 'glm-5.3' },
    { provider: 'zai-coding-cn-2', model: 'glm-5.3' },
    { provider: 'zai-coding-cn-3', model: 'glm-5.3' },
    { provider: 'deepseek-account', model: 'deepseek-flash' },
  ] }], cooldownMinutes: 3 }
  const probeCalls = []
  const stream = (options) => (async function* () {
    probeCalls.push(options.provider)
    if (options.provider === 'zai-coding-cn-2') {
      yield { type: 'finish', reason: { kind: 'error', failure: {
        code: 'RATE_LIMIT', status: 429,
        message: '429: {"code":"1310","message":"已达到 7 天使用上限，2026-11-17 16:11:05 后可继续使用。"}',
      } } }
      return
    }
    yield { type: 'text-delta', index: 0, text: 'p' }
  })()
  const run = async (probeOnDegraded) => {
    const ctx = makeCtx()
    ctx.llm.stream = stream
    const pool = createPool({ cooldownMs: 3 * 60_000, now: () => 1794810600000 })
    apply(ctx, { ...CHAIN, probeOnDegraded }, { pool, now: () => 1794810600000, logFile })
    const selection = { provider: 'zai-coding-cn', model: 'glm-5.3' }
    const agent = { id: 'probe-agent', session: { id: 'probe-session' }, model: {
      select: (s) => { Object.assign(selection, s) }, current: () => selection,
    } }
    await dispatch(ctx, 'agent/request', { agent, turn: 1, step: 1 }, async () => ({ provider: 'zai-coding-cn', model: 'glm-5.3' }))
    await dispatch(ctx, 'agent/request-error', { agent, turn: 1, step: 1, provider: 'zai-coding-cn', failure: {
      code: 'RATE_LIMIT', status: 429,
      message: '429: {"code":"1310","message":"已达到 7 天使用上限，2026-11-16 14:32:13 后可继续使用。"}',
    } }, async () => undefined)
    return { selection, pool, probes: probeCalls.length }
  }
  probeCalls.length = 0
  const verified = await run(true)
  if (verified.selection.provider !== 'zai-coding-cn-3') {
    failures.push('D1 预检后未落到可用账号：' + verified.selection.provider)
  }
  if (!verified.pool.isCooling('zai-coding-cn-2')) {
    failures.push('D2 预检发现的死号 zai-coding-cn-2 未被冷却')
  }
  if (verified.probes < 1) failures.push('D3 没有发出探针请求')
  probeCalls.length = 0
  const blind = await run(false)
  if (blind.selection.provider !== 'zai-coding-cn-2') {
    failures.push('D4 关闭预检时应保持链序行为（实际 ' + blind.selection.provider + '）')
  }
  return { failures, verified, blind }
}

// ---- 场景 E：启动巡检（0.13.0）----------------------------------------
// 14:48 事故：重启后会话仍带着已到期的选择，用户发消息先失败一次。期望：
// 启动后巡检活动会话，在用户发消息前就把选择换成已验证可用的账号。
async function checkSupervision() {
  const failures = []
  const CHAIN = { groups: [{ id: 'g', entries: [
    { provider: 'zai-coding-cn', model: 'glm-5.3' },
    { provider: 'zai-coding-cn-2', model: 'glm-5.3' },
    { provider: 'zai-coding-cn-3', model: 'glm-5.3' },
    { provider: 'deepseek-account', model: 'deepseek-flash' },
  ] }], cooldownMinutes: 3 }
  const build = async (probeOnDegraded) => {
    const selection = { provider: 'zai-coding-cn-2', model: 'glm-5.3' }
    const agent = { id: 'live-session', session: { id: 'live-session' }, model: {
      select: (s) => { Object.assign(selection, s) }, current: () => selection,
    } }
    const ctx = makeCtx()
    ctx.llm.stream = (options) => (async function* () {
      if (options.provider === 'zai-coding-cn-2') {
        yield { type: 'finish', reason: { kind: 'error', failure: {
          code: 'RATE_LIMIT', status: 429,
          message: '429: {"code":"1310","message":"已达到 7 天使用上限，2026-11-17 16:11:05 后可继续使用。"}',
        } } }
        return
      }
      yield { type: 'text-delta', index: 0, text: 'p' }
    })()
    ctx.get = (name) => name === 'agents' ? { list: () => [agent] } : undefined
    const pool = createPool({ cooldownMs: 3 * 60_000, now: () => Date.now() })
    apply(ctx, { ...CHAIN, probeOnDegraded }, { pool, now: () => Date.now(), logFile, supervisionStartDelayMs: 5 })
    pool.markReset('zai-coding-cn-2', Date.parse('2026-11-17T16:11:05+08:00'))
    await new Promise((resolve) => setTimeout(resolve, 120))
    return selection
  }
  const supervised = await build(true)
  if (supervised.provider === 'zai-coding-cn-2') failures.push('E1 启动巡检后仍停留在已到期账号')
  if (!CHAIN.groups[0].entries.some((e) => e.provider === supervised.provider)) failures.push('E2 巡检结果不在替补链内：' + supervised.provider)
  const blind = await build(false)
  if (blind.provider !== 'zai-coding-cn-2') failures.push('E3 关闭预检/巡检时应保持原选择（对照）')
  return { failures, supervised, blind }
}

// ---- 场景 F：手动选模型即时校验（0.14.0）-------------------------------
// 15:12/15:14 事故：用户在模型选择器里挑中已到期的 glm-5.3（zai-2），
// 2~3 秒后发送；宿主在装配时就用该账号定死路由 → 失败一次。期望：选中后
// ~250ms 内探针验证，死号立即换成可用账号，用户打字的时间足够完成切换。
async function checkSelectionVerification() {
  const failures = []
  const CHAIN = { groups: [{ id: 'g', entries: [
    { provider: 'zai-coding-cn', model: 'glm-5.3' },
    { provider: 'zai-coding-cn-2', model: 'glm-5.3' },
    { provider: 'zai-coding-cn-3', model: 'glm-5.3' },
    { provider: 'deepseek-account', model: 'deepseek-flash' },
  ] }], cooldownMinutes: 3 }
  const build = async (probeOnDegraded) => {
    const selection = { provider: 'zai-coding-cn-2', model: 'glm-5.3' }
    const agent = { id: 'pick-session', session: { id: 'pick-session' }, model: {
      select: (s) => { Object.assign(selection, s) }, current: () => selection,
    } }
    const ctx = makeCtx()
    ctx.llm.stream = (options) => (async function* () {
      if (options.provider === 'zai-coding-cn-2') {
        yield { type: 'finish', reason: { kind: 'error', failure: {
          code: 'RATE_LIMIT', status: 429,
          message: '429: {"code":"1310","message":"已达到 7 天使用上限，2026-11-17 16:11:05 后可继续使用。"}',
        } } }
        return
      }
      yield { type: 'text-delta', index: 0, text: 'p' }
    })()
    ctx.get = (name) => name === 'agents' ? { list: () => [agent] } : undefined
    const pool = createPool({ cooldownMs: 3 * 60_000, now: () => Date.now() })
    apply(ctx, { ...CHAIN, probeOnDegraded }, { pool, now: () => Date.now(), logFile, supervisionStartDelayMs: 60_000 })
    // 用户选中 zai-2 → 宿主记录 model/selection 事件
    for (const handler of ctx.listeners.get('session/event') ?? []) handler({ id: 'pick-session' }, { type: 'model/selection' })
    await new Promise((resolve) => setTimeout(resolve, 450))
    return { selection, pool }
  }
  const picked = await build(true)
  if (picked.selection.provider === 'zai-coding-cn-2') failures.push('F1 选中死号后未被即时换走')
  if (!picked.pool.isCooling('zai-coding-cn-2')) failures.push('F2 死号未被冷却')
  const off = await build(false)
  if (off.selection.provider !== 'zai-coding-cn-2') failures.push('F3 关闭预检时应保持用户选择（对照）')
  return { failures, picked, off }
}

const handoffFailures = await checkQuotaExpiryHandoff()
console.log('\n=== 场景 B：额度到期自动切换（ACCOUNT_QUOTA） ===')
for (const f of handoffFailures) console.log('  ❌ ' + f)
console.log(handoffFailures.length === 0 ? '  ✅ 真实失败账号被冷却，选择已交棒（B1/B2）' : `  ❌ ${handoffFailures.length} 项断言失败`)

const restartFailures = await checkRestartRecovery()
console.log('\n=== 场景 C：重启后不重复踩已知死号 ===')
for (const f of restartFailures) console.log('  ❌ ' + f)
console.log(restartFailures.length === 0 ? '  ✅ 重置时间持久化，重启后预检直接落到可用账号' : `  ❌ ${restartFailures.length} 项断言失败`)

const selectionPick = await checkSelectionVerification()
console.log('\n=== 场景 F：手动选模型即时校验 ===')
for (const f of selectionPick.failures) console.log('  ❌ ' + f)
console.log(selectionPick.failures.length === 0
  ? `  ✅ 选中死号后即迁到 ${selectionPick.picked.selection.provider}（对照仍停在 zai-coding-cn-2）`
  : `  ❌ ${selectionPick.failures.length} 项断言失败`)

const supervision = await checkSupervision()
console.log('\n=== 场景 E：启动巡检（用户发消息前换号） ===')
for (const f of supervision.failures) console.log('  ❌ ' + f)
console.log(supervision.failures.length === 0
  ? `  ✅ 启动即从 ${supervision.blind.provider} 迁到 ${supervision.supervised.provider}（对照组仍停在死号）`
  : `  ❌ ${supervision.failures.length} 项断言失败`)

const probeChain = await checkProbeChain()
console.log('\n=== 场景 D：替补链预检（1-token 探针） ===')
for (const f of probeChain.failures) console.log('  ❌ ' + f)
console.log(probeChain.failures.length === 0
  ? `  ✅ 一次失败 + ${probeChain.verified.probes} 次探针 → 直接落到 ${probeChain.verified.selection.provider}（链序盲切会落到 ${probeChain.blind.selection.provider}，还需再失败一次）`
  : `  ❌ ${probeChain.failures.length} 项断言失败`)

const mode = process.argv[2] ?? ''
const bounded = secondChance.length <= 8
if (mode === '--expect-thrash') {
  const thrash = secondChance.length > 10
  console.log(thrash ? '结论: ❌ 复现"一直切换失败"——探测风暴（>10 次/90 分钟）' : '结论: ✅ 未复现探测风暴')
  process.exitCode = thrash ? 1 : 0
} else if (mode === '--expect-bounded') {
  console.log(bounded ? '结论: ✅ 探测有界（≤8 次/90 分钟，指数退避生效）' : '结论: ❌ 探测仍过于频繁')
  process.exitCode = bounded ? 0 : 1
} else {
  process.exitCode = bounded && handoffFailures.length === 0 && restartFailures.length === 0
    && probeChain.failures.length === 0 && supervision.failures.length === 0
    && selectionPick.failures.length === 0 ? 0 : 1
}
rmSync(process.env.DSH_HOME, { recursive: true, force: true })
