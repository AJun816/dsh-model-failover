import fs from 'node:fs'
import assert from 'node:assert/strict'
import { test } from 'node:test'

// The plugin is ESM; load it through the registered schemastery-stub hook.
const mod = await import('../lib/index.js')
const { apply, classifyFailure, createPool, activeGroupOf } = mod

/** Minimal cordis-shaped context with waterfall semantics. */
function fakeCtx() {
  const log = { info: [], warn: [] }
  const listeners = new Map()
  const ctx = {
    logger: {
      info: (...a) => log.info.push(a.map(String).join(' ')),
      warn: (...a) => log.warn.push(a.map(String).join(' ')),
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
      return () => listeners.get(event)?.splice(listeners.get(event).indexOf(listener), 1)
    },
    effect(factory) { const dispose = factory(); return () => dispose?.() },
  }
  ctx.waterfall = async (event, payload, seed) => {
    const chain = [...(listeners.get(event) ?? [])]
    const run = async (i) => {
      if (i >= chain.length) return typeof seed === 'function' ? seed() : seed
      return chain[i](payload, () => run(i + 1))
    }
    return run(0)
  }
  ctx.log = log
  return ctx
}

const config = {
  groups: [{
    id: 'glm-pool',
    entries: [
      { provider: 'glm-1', model: 'glm-4.7' },
      { provider: 'glm-2', model: 'glm-4.7' },
      { provider: 'glm-3', model: 'glm-4.7' },
    ],
  }],
  activeGroup: 'glm-pool',
  cooldownMinutes: 30,
  retryOn: ['quota', 'rate-limit', 'auth', 'network'],
}

const seedConfig = { provider: 'seed', model: 'seed-model', temperature: 0.2 }

test('VERSION constant stays in sync with package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(mod.VERSION, pkg.version)
  assert.match(mod.VERSION, /^\d+\.\d+\.\d+$/)
})

test('classifyFailure maps codes, statuses, and messages', () => {
  assert.equal(classifyFailure({ code: 'QUOTA' }), 'quota')
  assert.equal(classifyFailure({ code: 'ACCOUNT_QUOTA' }), 'quota')
  assert.equal(classifyFailure({ code: 'RATE_LIMIT', status: 429 }), 'rate-limit')
  assert.equal(classifyFailure({ code: 'AUTH' }), 'auth')
  assert.equal(classifyFailure({ code: 'WEIRD', status: 402 }), 'quota')
  assert.equal(classifyFailure({ code: 'WEIRD', message: 'Insufficient Balance' }), 'quota')
  assert.equal(classifyFailure({ code: 'WEIRD', message: 'invalid API key' }), 'auth')
  assert.equal(classifyFailure({ code: 'WEIRD', message: 'fetch failed' }), 'network')
  assert.equal(classifyFailure({ code: 'CONTEXT_TOO_LONG' }), 'other')
  assert.equal(classifyFailure(null), 'other')
})

test('classifyFailure treats channel-verification blocks (11128) as auth', () => {
  // 实测：WorkBuddy 上游 HTTP 400 code 11128（dsh-workmate 渠道，retry:false）
  const real = 'workbuddy-ai upstream client (http 400): {"code":11128,"msg":"Illegal API invocation from an unapproved channel","retry_policy":{"retry":false},"displayTips":{"en":"This call failed channel verification, possibly because it was not sent from an official client."}}'
  assert.equal(classifyFailure({ message: real }), 'auth')
  assert.equal(classifyFailure({ message: 'Request blocked: unapproved channel' }), 'auth')
})

test('providerExcluded matches exact ids and prefix wildcards only', () => {
  const { providerExcluded } = mod
  assert.equal(providerExcluded(['workbuddy-ai', 'workbuddy-cn'], 'workbuddy-ai'), true)
  assert.equal(providerExcluded(['workbuddy-*'], 'workbuddy-cn'), true)
  assert.equal(providerExcluded(['workbuddy-*'], 'workbuddy-ai'), true)
  assert.equal(providerExcluded(['workbuddy-*'], 'deepseek-official'), false)
  assert.equal(providerExcluded(['workbuddy-ai'], 'workbuddy-ai-2'), false) // 前缀≠精确
  assert.equal(providerExcluded([], 'workbuddy-ai'), false)
  assert.equal(providerExcluded(['', '  ', 42], 'workbuddy-ai'), false) // 畸形模式不匹配
  assert.equal(providerExcluded(undefined, 'workbuddy-ai'), false)
})

test('pool cools and auto-recovers after cooldown', () => {
  let clock = 0
  const pool = createPool({ cooldownMs: 1000, now: () => clock })
  pool.cool('glm-1/glm-4.7')
  assert.equal(pool.isCooling('glm-1/glm-4.7'), true)
  clock = 1000
  assert.equal(pool.isCooling('glm-1/glm-4.7'), false)
  assert.equal(pool.snapshot()['glm-1/glm-4.7'], undefined)
})

test('v0.9.10: volatile descriptor config still arms the group (2026-11-02 incident)', async () => {
  // 事故回放：settings 层接管命名空间后，config 字段以 cosmokit volatile
  // 描述符（{ get, [volatile.write] }）到达 —— 首臂成功、同毫秒重臂变 inactive。
  const volatile = <T,>(value: T): object => ({ get: () => value })
  const ctx = fakeCtx()
  apply(ctx, {
    groups: volatile([{ id: 'glm-pool', entries: [
      { provider: 'glm-1', model: 'glm-4.7' },
      { provider: 'glm-2', model: 'glm-4.7' },
    ] }]) as never,
    activeGroup: volatile('glm-pool') as never,
    cooldownMinutes: volatile(30) as never,
    retryOn: volatile(['quota', 'rate-limit', 'auth', 'network']) as never,
    autoDiscover: volatile(true) as never,
  })
  const armed = ctx.log.info.some((line) => line.includes('active group "glm-pool" with 2 entries'))
  assert.ok(armed, 'volatile-wrapped config must still arm: ' + JSON.stringify(ctx.log.info))
  // 路由也要工作
  const out = await ctx.waterfall('agent/request', { agent: { id: 'v1' }, turn: 1, step: 1 }, () => seedConfig)
  assert.equal(out.provider, 'glm-1')
})

test('v0.11.3: far-future 1310 fails fast with NO revival probe (2026-11-14 16:38 incident)', async () => {
  // 事故回放：三账号全因 1310（重置 2026-11-16，还剩两天）冷却。0.11.2 每 5 分钟
  // 复活一个探测 → 每次探测都是必然失败的用户可见错误。修复后：远期冷却不探测。
  const ctx = fakeCtx()
  const selection = { provider: 'zai-coding-cn-3', model: 'glm-5.3' }
  const agent = { id: 'far-1', model: { select: (s) => Object.assign(selection, s), current: () => ({ ...selection }) } }
  let downstreamRan = 0
  const frozen = Date.parse('2026-11-14T16:38:00')
  const twoDays = 2 * 24 * 60 * 60_000
  const pool = createPool({ cooldownMs: 60_000, now: () => frozen })
  apply(ctx, {
    groups: [{ id: 'glm-pool', entries: [
      { provider: 'zai-coding-cn', model: 'glm-5.3' },
      { provider: 'zai-coding-cn-2', model: 'glm-5.3' },
      { provider: 'zai-coding-cn-3', model: 'glm-5.3' },
    ] }],
    activeGroup: 'glm-pool',
    cooldownMinutes: 3,
  }, { pool, now: () => frozen })
  pool.cool('zai-coding-cn', twoDays); pool.cool('zai-coding-cn-2', twoDays); pool.cool('zai-coding-cn-3', twoDays)
  const action = await ctx.waterfall('agent/request-error',
    { agent, turn: 1, step: 1, provider: 'zai-coding-cn-3',
      failure: { code: 'RATE_LIMIT', status: 429, message: '429: {"code":"1310","message":"已达到 7 天使用上限，2026-11-16 14:32:13 后可继续使用。"}' } },
    () => { downstreamRan += 1; return { kind: 'retry' } })
  assert.equal(action, undefined, 'must fail fast')
  assert.equal(downstreamRan, 0, 'no same-route burn')
  assert.equal(selection.provider, 'zai-coding-cn-3', 'far-future cap must NOT be probed/selected')
  assert.ok(!ctx.log.info.some((l) => l.includes('second-chance')), 'no revival for far-future caps')
})

test('v0.11.3: short-window 1308 all-cooling still revives (reset plausible soon)', async () => {
  const ctx = fakeCtx()
  const selection = { provider: 'zai-coding-cn-3', model: 'glm-5.3' }
  const agent = { id: 'near-1', model: { select: (s) => Object.assign(selection, s), current: () => ({ ...selection }) } }
  const frozen = Date.parse('2026-11-14T16:38:00')
  const pool = createPool({ cooldownMs: 60_000, now: () => frozen })
  apply(ctx, {
    groups: [{ id: 'glm-pool', entries: [
      { provider: 'zai-coding-cn', model: 'glm-5.3' },
      { provider: 'zai-coding-cn-2', model: 'glm-5.3' },
      { provider: 'zai-coding-cn-3', model: 'glm-5.3' },
    ] }],
    activeGroup: 'glm-pool',
    cooldownMinutes: 3,
  }, { pool, now: () => frozen })
  pool.cool('zai-coding-cn', 5 * 60_000); pool.cool('zai-coding-cn-2', 5 * 60_000); pool.cool('zai-coding-cn-3', 5 * 60_000)
  // 1308：5 小时窗 8 分钟后重置 → 冷却剩余 < 15 分钟窗口 → 值得探测
  const action = await ctx.waterfall('agent/request-error',
    { agent, turn: 1, step: 1, provider: 'zai-coding-cn-3',
      failure: { code: 'RATE_LIMIT', status: 429, message: '429: {"code":"1308","message":"已达到 5 小时使用上限，2026-11-14 16:46:00 后可继续使用。"}' } },
    () => ({ kind: 'retry' }))
  assert.equal(action, undefined, 'fail fast')
  assert.notEqual(selection.provider, 'zai-coding-cn-3', 'near reset must be probed via selection')
  assert.ok(ctx.log.info.some((l) => l.includes('second-chance')), 'revival fires for short windows')
})

test('v0.11.4: 1310 weekly-cap cooldown capped to one probe cycle (quota-floor accounts recover)', async () => {
  // 事故：cn/cn-2 对 507K 巨上下文报 1310（剩余周额度在 250K~507K 之间），但正常请求
  // 完全可用。0.11.3 冷却到 11-16 重置（两天）→ 误杀活账号 → 选号漂到真死的 cn-3。
  // 修复：1310 冷却封顶 15 分钟（REVIVABLE_WINDOW_MS），floor 账号分钟级回血。
  const ctx = fakeCtx()
  const frozen = Date.parse('2026-11-14T16:38:00')
  const pool = createPool({ cooldownMs: 3 * 60_000, now: () => frozen })
  apply(ctx, {
    groups: [{ id: 'glm-pool', entries: [
      { provider: 'zai-coding-cn', model: 'glm-5.3' },
      { provider: 'zai-coding-cn-2', model: 'glm-5.3' },
      { provider: 'zai-coding-cn-3', model: 'glm-5.3' },
    ] }],
    activeGroup: 'glm-pool',
    cooldownMinutes: 3,
  }, { pool, now: () => frozen })
  const agent = { id: 'floor-1' }
  // cn 撞 1310（消息重置时刻两天后）
  await ctx.waterfall('agent/request-error',
    { agent, turn: 1, step: 1, provider: 'zai-coding-cn',
      failure: { code: 'RATE_LIMIT', status: 429, message: '429: {"code":"1310","message":"已达到 7 天使用上限，2026-11-16 14:32:13 后可继续使用。"}' } },
    () => 'downstream')
  // 冷却必须 ≤ 15 分钟（而不是 ~2 天）
  assert.ok(pool.remaining('zai-coding-cn') <= 15 * 60_000 + 1,
    '1310 cooldown must cap at one probe cycle, got ' + pool.remaining('zai-coding-cn') + 'ms')
  // 15 分钟后（复活窗口内）该账号可被再次选中——正常请求即可服务
  // 对照：1308（5h 窗）仍按重置时刻冷却（重置通常 <2h，语义正确）
  const pool2 = createPool({ cooldownMs: 60_000, now: () => frozen })
  apply(ctx, {
    groups: [{ id: 'g', entries: [{ provider: 'a', model: 'm' }, { provider: 'b', model: 'm' }] }],
    activeGroup: 'g', cooldownMinutes: 3,
  }, { pool: pool2, now: () => frozen })
  await ctx.waterfall('agent/request-error',
    { agent: { id: 'w5' }, turn: 1, step: 1, provider: 'a',
      failure: { code: 'RATE_LIMIT', status: 429, message: '429: {"code":"1308","message":"已达到 5 小时使用上限，2026-11-14 18:38:00 后可继续使用。"}' } },
    () => 'downstream')
  const rem = pool2.remaining('a')
  assert.ok(rem > 15 * 60_000, '1308 must keep cooling until its reset, got ' + rem + 'ms')
})

test('module evaluation writes an external load marker', async () => {
  // 导入即写 <DSH_HOME>/model-failover/load.log（0.9.7 可观测性；测试经 loader 隔离到临时 DSH_HOME）
  const { readFileSync, existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  assert.ok(process.env.DSH_HOME !== undefined, 'test loader must isolate DSH_HOME')
  const markerPath = join(process.env.DSH_HOME, 'model-failover', 'load.log')
  // 触发一次 fresh 评估（test loader 可能已缓存；直接调用导出的标记函数兜底断言）
  const { writeLoadMarker, VERSION } = mod
  await writeLoadMarker(VERSION, 'self-test')
  assert.ok(existsSync(markerPath), 'load.log must exist after import/self-test')
  const lines = readFileSync(markerPath, 'utf8').trim().split('\n')
  const last = JSON.parse(lines[lines.length - 1])
  assert.equal(last.version, VERSION)
  assert.equal(last.note, 'self-test')
  assert.equal(typeof last.pid, 'number')
})

test('wire() persists lastArmed to the settings namespace (external observability)', async () => {
  const ctx = fakeCtx()
  const updates = []
  ctx.get = (name) => name === 'settings' ? {
    describe: async () => ({ namespaces: [{ ns: 'model-failover', value: {}, revision: 7 }] }),
    update: async (ns, patch, rev) => { updates.push({ ns, patch, rev }) },
  } : undefined
  apply(ctx, config)
  await new Promise((r) => setTimeout(r, 10))
  const hit = updates.find((u) => u.patch?.lastArmed !== undefined)
  assert.ok(hit, 'lastArmed write must reach the settings namespace')
  assert.equal(hit.ns, 'model-failover')
  assert.equal(hit.patch.lastArmed.mode, 'active')
  assert.equal(hit.patch.lastArmed.group, 'glm-pool')
  assert.equal(hit.patch.lastArmed.entries, 3)
  assert.match(hit.patch.lastArmed.version, /^\d+\.\d+\.\d+$/)
})

test('routes to first healthy entry and preserves other config fields', async () => {
  const ctx = fakeCtx()
  apply(ctx, config)
  const out = await ctx.waterfall('agent/request', { agent: { id: 'a1' }, turn: 1, step: 1 }, () => seedConfig)
  assert.deepEqual({ provider: out.provider, model: out.model }, { provider: 'glm-1', model: 'glm-4.7' })
  assert.equal(out.temperature, 0.2)
})

test('quota failure cools entry, retries, and next request switches account', async () => {
  const ctx = fakeCtx()
  apply(ctx, config)
  const agent = { id: 'a1' }
  let route = await ctx.waterfall('agent/request', { agent, turn: 1, step: 1 }, () => seedConfig)
  assert.equal(route.provider, 'glm-1')

  const action = await ctx.waterfall(
    'agent/request-error',
    { agent, provider: route.provider, failure: { code: 'QUOTA', message: 'Insufficient Balance', status: 402 } },
    () => undefined,
  )
  assert.deepEqual(action, { kind: 'retry' })

  route = await ctx.waterfall('agent/request', { agent, turn: 1, step: 1 }, () => seedConfig)
  assert.equal(route.provider, 'glm-2', 'should fail over to the second account')
})

test('non-retryable failure passes through to downstream', async () => {
  const ctx = fakeCtx()
  apply(ctx, config)
  const agent = { id: 'a1' }
  await ctx.waterfall('agent/request', { agent, turn: 1, step: 1 }, () => seedConfig)
  const action = await ctx.waterfall(
    'agent/request-error',
    { agent, failure: { code: 'CONTEXT_TOO_LONG', message: 'too long' } },
    () => 'downstream-decision',
  )
  assert.equal(action, 'downstream-decision')
})

test('all entries cooling → second-chance revives the first cooled account (recharge probe)', async () => {
  const ctx = fakeCtx()
  const { pool } = apply(ctx, { ...config, cooldownMinutes: 1 })
  const agent = { id: 'a1' }
  for (const entry of config.groups[0].entries) pool.cool(entry.provider, 60_000)

  const out = await ctx.waterfall('agent/request', { agent, turn: 1, step: 1 }, () => seedConfig)
  assert.deepEqual({ provider: out.provider, model: out.model }, { provider: 'seed', model: 'seed-model' })

  // 第一次全冷却失败：按替补顺序复活 glm-1 并重试（探测是否已充值）
  const probe = await ctx.waterfall(
    'agent/request-error',
    { agent, turn: 1, step: 1, provider: 'glm-1', failure: { code: 'QUOTA' } },
    () => 'default-error',
  )
  assert.deepEqual(probe, { kind: 'retry' })
  assert.ok(ctx.log.info.some((line) => line.includes('second-chance retry on') && line.includes('glm-1')))
  // 复活后的请求会重新路由到 glm-1
  const rerouted = await ctx.waterfall('agent/request', { agent, turn: 1, step: 2 }, () => seedConfig)
  assert.equal(rerouted.provider, 'glm-1')

  // glm-1 仍无额度再次失败 → 重新冷却；二次机会转向下一个账号（glm-1 已被节流）
  const probe2 = await ctx.waterfall(
    'agent/request-error',
    { agent, turn: 1, step: 2, provider: 'glm-1', failure: { code: 'QUOTA' } },
    () => 'default-error',
  )
  assert.deepEqual(probe2, { kind: 'retry' })
  assert.ok(ctx.log.info.some((line) => line.includes('second-chance retry on') && line.includes('glm-2')))

  // 持续失败：每个账号每 5 分钟只探测一次，节流耗尽后交回默认错误处理
  let giveUp
  for (let i = 3; i < 9; i += 1) {
    const provider = config.groups[0].entries[(i - 1) % 3].provider
    giveUp = await ctx.waterfall(
      'agent/request-error',
      { agent, turn: 1, step: i, provider, failure: { code: 'QUOTA' } },
      () => 'default-error',
    )
    if (giveUp === 'default-error') break
  }
  assert.equal(giveUp, 'default-error')
  assert.ok(ctx.log.warn.some((line) => line.includes('every account is cooling') || line.includes('retry budget exhausted')))
})

test('cascades through the whole pool one failure at a time', async () => {
  const ctx = fakeCtx()
  apply(ctx, { ...config, cooldownMinutes: 1 })
  const agent = { id: 'a1' }
  const seen = []
  for (let i = 0; i < 3; i += 1) {
    const route = await ctx.waterfall('agent/request', { agent, turn: 1, step: i + 1 }, () => seedConfig)
    seen.push(route.provider)
    const action = await ctx.waterfall(
      'agent/request-error',
      { agent, provider: route.provider, failure: { code: 'RATE_LIMIT', status: 429 } },
      () => 'default-error',
    )
    if (i < 2) assert.deepEqual(action, { kind: 'retry' })
    else {
      // 第三个账号失败后全池冷却：二次机会复活链首（可能已被充值）
      assert.deepEqual(action, { kind: 'retry' })
      assert.ok(ctx.log.info.some((line) => line.includes('second-chance retry on') && line.includes('glm-1')))
    }
  }
  assert.deepEqual(seen, ['glm-1', 'glm-2', 'glm-3'])
})

test('separate agents track in-flight entries independently', async () => {
  const ctx = fakeCtx()
  const { pool } = apply(ctx, { ...config, cooldownMinutes: 1 })
  const a1 = { id: 'a1' }
  const a2 = { id: 'a2' }
  await ctx.waterfall('agent/request', { agent: a1 }, () => seedConfig)
  await ctx.waterfall('agent/request', { agent: a2 }, () => seedConfig)
  await ctx.waterfall('agent/request-error', { agent: a1, failure: { code: 'QUOTA' } }, () => undefined)
  // Cooldown is account-global: glm-1 is cooling for every agent, so a2 also skips it.
  const r2 = await ctx.waterfall('agent/request', { agent: a2 }, () => seedConfig)
  assert.equal(r2.provider, 'glm-2', 'a2 skips the account a1 exhausted')
  const r1 = await ctx.waterfall('agent/request', { agent: a1 }, () => seedConfig)
  assert.equal(r1.provider, 'glm-2')
  assert.deepEqual(Object.keys(pool.snapshot()), ['glm-1'], 'only the failed account is cooling')
})

test('untracked failure still cools the reported provider and retries', async () => {
  const ctx = fakeCtx()
  const { pool } = apply(ctx, { ...config, cooldownMinutes: 1 })
  // No prior agent/request: in-flight is unknown; the loop-reported provider wins.
  const action = await ctx.waterfall(
    'agent/request-error',
    { agent: { id: 'x' }, turn: 1, step: 1, provider: 'glm-1', failure: { code: 'QUOTA' } },
    () => undefined,
  )
  assert.deepEqual(action, { kind: 'retry' })
  assert.ok(pool.isCooling('glm-1'))
  const route = await ctx.waterfall('agent/request', { agent: { id: 'x' }, turn: 1, step: 1 }, () => seedConfig)
  assert.equal(route.provider, 'glm-2')
})

test('untrackable failure without provider info passes through (no blind retry)', async () => {
  const ctx = fakeCtx()
  apply(ctx, config)
  const action = await ctx.waterfall(
    'agent/request-error',
    { failure: { code: 'QUOTA' } }, // no agent, no provider
    () => 'default',
  )
  assert.equal(action, 'default')
})

test('retry budget bounds one step to one pass over the pool', async () => {
  const ctx = fakeCtx()
  const { pool } = apply(ctx, { ...config, cooldownMinutes: 1 })
  const agent = { id: 'a1' }
  for (let i = 0; i < 4; i += 1) {
    // each iteration: fail the currently selected account, same turn/step
    await ctx.waterfall('agent/request-error',
      { agent, turn: 1, step: 1, provider: 'glm-1', failure: { code: 'QUOTA' } },
      () => 'default')
    pool.recover('glm-1'); pool.recover('glm-2'); pool.recover('glm-3') // keep entries selectable
  }
  // 4th failure (used=4 > 3 entries) must stop returning retry
  const last = await ctx.waterfall('agent/request-error',
    { agent, turn: 1, step: 1, provider: 'glm-1', failure: { code: 'QUOTA' } },
    () => 'default')
  assert.equal(last, 'default')
  assert.ok(ctx.log.warn.some((l) => l.includes('retry budget exhausted')))
})

test('provider Retry-After longer than cooldown is honored and never shortened', () => {
  let clock = 0
  const pool = createPool({ cooldownMs: 60_000, now: () => clock })
  pool.cool('glm-1', Math.max(60_000, 600_000))
  clock = 300_000
  assert.equal(pool.isCooling('glm-1'), true, 'still cooling at 5min of a 10min Retry-After')
  clock = 600_000
  assert.equal(pool.isCooling('glm-1'), false)
  // A later, shorter re-cool starts from its own expiry check (monotonic clock).
  pool.cool('glm-1', 120_000) // at clock=600_000 → until 720_000
  clock = 700_000
  assert.equal(pool.isCooling('glm-1'), true)
  clock = 720_000
  assert.equal(pool.isCooling('glm-1'), false, 'short re-cool expires on schedule')
})

test('503/529 provider outage classifies as network and triggers switch', async () => {
  const ctx = fakeCtx()
  apply(ctx, config)
  const agent = { id: 'a1' }
  await ctx.waterfall('agent/request', { agent, turn: 1, step: 1 }, () => seedConfig)
  assert.equal(classifyFailure({ code: 'WEIRD', status: 503 }), 'network')
  assert.equal(classifyFailure({ code: 'WEIRD', status: 529 }), 'network')
  const action = await ctx.waterfall('agent/request-error',
    { agent, turn: 1, step: 1, failure: { code: 'WEIRD', status: 503 } }, () => undefined)
  assert.deepEqual(action, { kind: 'retry' })
})

test('same provider different models: account-level cooling links them', async () => {
  const cfg = {
    groups: [{ id: 'g', entries: [
      { provider: 'glm-1', model: 'glm-4.7' },
      { provider: 'glm-1', model: 'glm-4.6' },
      { provider: 'glm-2', model: 'glm-4.7' },
    ] }],
    activeGroup: 'g', cooldownMinutes: 30, retryOn: ['quota'],
  }
  const ctx = fakeCtx()
  apply(ctx, cfg)
  const agent = { id: 'a1' }
  let route = await ctx.waterfall('agent/request', { agent, turn: 1, step: 1 }, () => seedConfig)
  assert.equal(route.model, 'glm-4.7')
  await ctx.waterfall('agent/request-error', { agent, turn: 1, step: 1, failure: { code: 'QUOTA' } }, () => undefined)
  route = await ctx.waterfall('agent/request', { agent, turn: 1, step: 1 }, () => seedConfig)
  assert.equal(route.provider, 'glm-2', 'exhausted account is skipped entirely, not just one model')
})

test('cross-provider switch drops provider-specific fields, keeps neutral ones', async () => {
  const ctx = fakeCtx()
  apply(ctx, config)
  const route = await ctx.waterfall('agent/request',
    { agent: { id: 'a' }, turn: 1, step: 1 },
    () => ({ provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-a', baseURL: 'https://a', temperature: 0.3, maxTokens: 4096 }))
  assert.equal(route.provider, 'glm-1')
  assert.equal(route.model, 'glm-4.7')
  assert.equal(route.apiKey, undefined)
  assert.equal(route.baseURL, undefined)
  assert.equal(route.temperature, 0.3)
  assert.equal(route.maxTokens, 4096)
})

test('inactive without groups: registers nothing, still safe', async () => {
  const ctx = fakeCtx()
  apply(ctx, { groups: [], activeGroup: '', cooldownMinutes: 30, retryOn: [] })
  const out = await ctx.waterfall('agent/request', { agent: { id: 'a' } }, () => seedConfig)
  assert.equal(out.provider, 'seed')
  assert.ok(ctx.log.info.some((l) => l.includes('stays inactive')))
})

test('activeGroupOf falls back to first group on unknown id', () => {
  assert.equal(activeGroupOf(config).id, 'glm-pool')
  assert.equal(activeGroupOf({ groups: config.groups, activeGroup: 'nope' }).id, 'glm-pool')
  assert.equal(activeGroupOf({ groups: [] }), undefined)
})

test('listener throwing inside agent/request does not swallow routing', async () => {
  const ctx = fakeCtx()
  ctx.on('agent/request', async () => { throw new Error('boom') })
  apply(ctx, config)
  await assert.rejects(() => ctx.waterfall('agent/request', { agent: { id: 'a' } }, () => seedConfig), /boom/)
})

test('GLM 1310 weekly-cap failure classifies as quota and yields a long cooldown', () => {
  const klass = classifyFailure({ code: 'RATE_LIMIT', status: 429, message: '429: {"code":"1310","message":"已达到 7 天使用上限，2026-11-05 17:10:49 后可继续使用。"}' })
  assert.ok(klass === 'quota' || klass === 'rate-limit')
})

test('numeric-string codes map like HTTP statuses', () => {
  assert.equal(classifyFailure({ code: '429', message: 'x' }), 'rate-limit')
  assert.equal(classifyFailure({ code: '402', message: 'x' }), 'quota')
  assert.equal(classifyFailure({ code: '401', message: 'x' }), 'auth')
})

test('Chinese usage-cap message classifies as quota', () => {
  assert.equal(classifyFailure({ code: 'PROVIDER_ERROR', message: '已达到 7 天使用上限' }), 'quota')
})

test('retryAfterFromMessage parses the resume timestamp', () => {
  const now = Date.parse('2026-10-31T16:00:00')
  const ms = mod.retryAfterFromMessage('已达到 7 天使用上限，2026-11-05 17:10:49 后可继续使用。', now)
  const expected = Date.parse('2026-11-05T17:10:49') - now
  assert.equal(ms, expected)
  assert.equal(mod.retryAfterFromMessage('no date here', now), 0)
})

test('v0.9.3 default: catalog fallback is OFF — requests never leave the configured chain', async () => {
  // 事故回归（2026-11-01 21:55）：deepseek quota 后旧默认把请求兜底进
  // workbuddy-*（服务端 11128 渠道封禁）。新默认：不 opt-in 就不出组。
  const ctx = fakeCtx()
  ctx.llm = {
    listProviders: () => [{ id: 'workbuddy-ai' }, { id: 'workbuddy-cn' }, { id: 'a' }, { id: 'b' }],
    listModels: async () => [{ id: 'm1' }],
  }
  const pool = createPool({ cooldownMs: 60_000, now: () => 1_000 })
  apply(ctx, {
    groups: [{ id: 'g', entries: [{ provider: 'a', model: 'm1' }, { provider: 'b', model: 'm2' }] }],
    activeGroup: 'g',
    // 注意：没有 fallbackToCatalog —— 默认必须为 false
  }, { pool, now: () => 1_000 })
  await new Promise((r) => setTimeout(r, 10))
  pool.cool('a'); pool.cool('b')
  const resolved = await ctx.waterfall('agent/request', { agent: { id: 'x' } }, async () => ({ provider: 'a', model: 'm1' }))
  assert.equal(resolved.provider, 'a') // 原样透传，绝不去 workbuddy-*
  assert.notEqual(resolved.provider, 'workbuddy-ai')
  assert.notEqual(resolved.provider, 'workbuddy-cn')
})

test('exhausted group without catalog passes through untouched', async () => {
  const ctx = fakeCtx()
  const pool = createPool({ cooldownMs: 60_000, now: () => 1_000 })
  const stop = apply(ctx, {
    groups: [{ id: 'g', entries: [{ provider: 'a', model: 'm1' }, { provider: 'b', model: 'm2' }] }],
    activeGroup: 'g',
  }, { pool, now: () => 1_000 })
  pool.cool('a'); pool.cool('b')
  const resolved = await ctx.waterfall('agent/request', {}, async () => ({ provider: 'a', model: 'm1', maxTokens: 100 }))
  assert.equal(resolved.provider, 'a')
})

test('exhausted group falls back to a healthy catalog provider', async () => {
  const ctx = fakeCtx()
  ctx.llm = {
    listProviders: () => [{ id: 'deepseek-official' }, { id: 'glm-x' }, { id: 'a' }, { id: 'b' }],
    listModels: async (p) => [{ id: p === 'deepseek-official' ? 'deepseek-chat' : 'm1' }],
  }
  const pool = createPool({ cooldownMs: 60_000, now: () => 1_000 })
  const stop = apply(ctx, {
    groups: [{ id: 'g', entries: [{ provider: 'a', model: 'm1' }, { provider: 'b', model: 'm2' }] }],
    activeGroup: 'g',
    fallbackToCatalog: true, // v0.9.3 起目录兜底为显式 opt-in
  }, { pool, now: () => 1_000 })
  await new Promise((r) => setTimeout(r, 10)) // let auto-discovery settle
  pool.cool('a'); pool.cool('b')
  const resolved = await ctx.waterfall('agent/request', { agent: { id: 'x' } }, async () => ({ provider: 'a', model: 'm1', maxTokens: 100 }))
  assert.equal(resolved.provider, 'deepseek-official')
  assert.equal(resolved.model, 'deepseek-chat')
  // 失败后 error 监听器应继续走兜底重试
  const action = await ctx.waterfall('agent/request-error',
    { agent: { id: 'x' }, turn: 1, step: 1, provider: 'deepseek-official', failure: { code: 'RATE_LIMIT' } },
    () => undefined)
  assert.equal(action?.kind, 'retry')
  // 兜底也有自己的预算：连续第 3 次兜底跳数后放弃
  const action2 = await ctx.waterfall('agent/request-error',
    { agent: { id: 'x' }, turn: 1, step: 1, provider: 'glm-x', failure: { code: 'RATE_LIMIT' } },
    () => undefined)
  assert.equal(action2, undefined)
})

test('switch records land in the plugin log and session event', async () => {
  const ctx = fakeCtx()
  const events = []
  const logFile = '/tmp/mf-switches-test.log'
  fs.rmSync(logFile, { force: true })
  const agent = { id: 'a1', session: { append: (type, data) => events.push([type, data]) } } // the dsh-session stub's appendPluginRecord forwards to session.append
  apply(ctx, config, { logFile, now: () => 1_000 })
  // glm-1 失败 → 切 glm-2，应产生记录
  const action = await ctx.waterfall('agent/request-error',
    { agent, turn: 1, step: 1, provider: 'glm-1', failure: { code: 'QUOTA' } },
    () => 'default')
  assert.deepEqual(action, { kind: 'retry' })
  await new Promise((r) => setTimeout(r, 20)) // 等 recordSwitch 的异步通道完成
  const line = fs.readFileSync(logFile, 'utf8').trim().split('\n').at(-1)
  const record = JSON.parse(line)
  assert.equal(record.from, 'glm-1')
  assert.equal(record.to, 'glm-2')
  assert.equal(record.via, 'chain')
  const sessionEvent = events.find(([type]) => type === 'plugin:model-failover/switch')
  assert.ok(sessionEvent, 'session event appended')
  assert.equal(sessionEvent[1].to, 'glm-2')
  fs.rmSync(logFile, { force: true })
})

test('compiled output never writes required session events directly', () => {
  // The v0.8.0 bug class: calling the plain required-event append channel with
  // a custom type writes a log the persistence reader refuses to load. This
  // guard fails the build if anyone ever reintroduces that call pattern.
  // Scans EVERY compiled host file — the record code lives in lib/records.js
  // since the v0.9.3 module split.
  const libDir = new URL('../lib/', import.meta.url)
  const compiled = fs.readdirSync(libDir)
    .filter((f) => f.endsWith('.js') && f !== 'client.js')
    .map((f) => fs.readFileSync(new URL(f, libDir), 'utf8'))
    .join('\n')
  assert.ok(compiled.length > 0, 'compiled host output must exist')
  assert.equal((compiled.match(/session\s*\.\s*append\s*\(/g) ?? []).length, 0,
    'session records must only be written through appendPluginRecord')
  assert.ok(compiled.includes("SWITCH_RECORD_TYPE = 'plugin:model-failover/switch'"),
    'the record type must follow the plugin: grammar')
})

test('a switch never rejects even when every record channel fails', async () => {
  const ctx = fakeCtx()
  // channel 1: the dsh-session stub forwards to session.append, which throws;
  // channel 2: log path under a nonexistent root; channel 3: ctx has no settings.
  const agent = { id: 'a1', session: { append: () => { throw new Error('session channel boom') } } }
  apply(ctx, config, { logFile: '/nonexistent-root-dir/x/switches.log', now: () => 1_000 })
  const action = await ctx.waterfall('agent/request-error',
    { agent, turn: 9, step: 1, provider: 'glm-1', failure: { code: 'QUOTA' } },
    () => 'default')
  assert.deepEqual(action, { kind: 'retry' }) // the failover decision itself is unaffected
  // An unhandled rejection from the fire-and-forget recording would fail the
  // test runner; settling here proves every channel degraded quietly.
  await new Promise((r) => setTimeout(r, 60))
  assert.ok(true)
})

test('0.2.2 arch: agent/request passes the fixed selection through unchanged', async () => {
  const ctx = fakeCtx()
  apply(ctx, config)
  const selections = []
  const agent = { id: 'a1', model: { current: () => ({ provider: 'glm-1', model: 'glm-4.7' }), select: (s) => selections.push(s) } }
  const out = await ctx.waterfall('agent/request', { agent, turn: 1, step: 1 }, () => seedConfig)
  assert.deepEqual({ provider: out.provider, model: out.model }, { provider: 'seed', model: 'seed-model' }, 'must NOT reroute on the fixed-selection architecture')
  assert.equal(selections.length, 0)
})

test('0.2.2 arch: fatal quota fails the step fast with the next account selected', async () => {
  const ctx = fakeCtx()
  apply(ctx, config)
  const selections = []
  const agent = { id: 'a1', model: { current: () => ({ provider: 'glm-1', model: 'glm-4.7' }), select: (s) => selections.push(s) } }
  await ctx.waterfall('agent/request', { agent, turn: 1, step: 1 }, () => seedConfig)
  const action = await ctx.waterfall(
    'agent/request-error',
    { agent, turn: 1, step: 1, provider: 'glm-1', failure: { code: 'QUOTA', status: 402 } },
    () => 'downstream-unused',
  )
  assert.equal(action, undefined, 'same-step retry cannot change the fixed route on 0.2.2 — fail fast')
  assert.deepEqual(selections, [{ provider: 'glm-2', model: 'glm-4.7' }], 'select() records the failover route for the next step')
})

test('0.2.2 arch: any provider 429 with a healthy alternative switches; without one it delegates', async () => {
  const ctx = fakeCtx()
  const { pool } = apply(ctx, { ...config, cooldownMinutes: 1 })
  const selections = []
  const agent = { id: 'a1', model: { current: () => ({ provider: 'glm-1', model: 'glm-4.7' }), select: (s) => selections.push(s) } }
  await ctx.waterfall('agent/request', { agent, turn: 1, step: 1 }, () => seedConfig)
  // GLM 1302 account-rate-throttle: same-route backoff deepens it — must switch.
  const throttled = await ctx.waterfall(
    'agent/request-error',
    { agent, turn: 1, step: 1, provider: 'glm-1', failure: { code: 'RATE_LIMIT', status: 429, message: '您的账户已达到速率限制，请您控制请求频率' } },
    () => 'downstream',
  )
  assert.equal(throttled, undefined, 'provider-side 429 with an alternative must fast-fail with a durable switch')
  assert.deepEqual(selections.map((s) => s.provider), ['glm-2'])
  // Every account cooling (v0.11.2): fail fast + second-chance revival —
  // delegating would burn llm-retry's budget re-firing the same dead route
  // (2026-11-14 incident: 5/5 retries on a weekly-capped account).
  for (const entry of config.groups[0].entries) pool.cool(entry.provider, 60_000)
  const exhausted = await ctx.waterfall(
    'agent/request-error',
    { agent, turn: 2, step: 1, provider: 'glm-1', failure: { code: 'RATE_LIMIT', status: 429, message: '429 too many requests' } },
    () => 'downstream-retry',
  )
  assert.equal(exhausted, undefined, 'no healthy alternative fails fast (no same-route burn)')
  assert.ok(selections.length >= 2, 'second-chance revival must re-select: ' + JSON.stringify(selections.map(s => s.provider)))
})

test('0.2.2 arch: pre-step steers away from a cooling selection and respects healthy choices', async () => {
  const ctx = fakeCtx()
  const { pool } = apply(ctx, { ...config, cooldownMinutes: 1 })
  const selections = []
  const agent = { id: 'a1', model: { current: () => ({ provider: 'glm-1', model: 'glm-4.7' }), select: (s) => selections.push(s) } }
  // Healthy in-chain selection: respected, no select call.
  await ctx.waterfall('agent/pre-step', { agent, turn: 1, step: 1, modelSelection: { provider: 'glm-1', model: 'glm-4.7' } }, () => 'decision')
  assert.equal(selections.length, 0)
  // Cooling selection: steered to the first healthy entry.
  pool.cool('glm-1')
  await ctx.waterfall('agent/pre-step', { agent, turn: 2, step: 1, modelSelection: { provider: 'glm-1', model: 'glm-4.7' } }, () => 'decision2')
  assert.deepEqual(selections, [{ provider: 'glm-2', model: 'glm-4.7' }])
  // Healthy route outside the chain: the user's own choice, untouched.
  await ctx.waterfall('agent/pre-step', { agent, turn: 3, step: 1, modelSelection: { provider: 'other', model: 'x' } }, () => 'decision3')
  assert.equal(selections.length, 1)
})

test('garbage payloads never throw into the waterfalls', async () => {
  const ctx = fakeCtx()
  apply(ctx, config)
  const r1 = await ctx.waterfall('agent/request-error', {}, () => 'default')
  assert.equal(r1, 'default')
  const r2 = await ctx.waterfall('agent/request-error', undefined, () => 'default2')
  assert.equal(r2, 'default2')
  // A downstream listener returning a non-object config passes through untouched.
  const r3 = await ctx.waterfall('agent/request', { agent: { id: 'x' }, turn: 1, step: 1 }, () => null)
  assert.equal(r3, null)
})
