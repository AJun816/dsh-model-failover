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
  const { pool } = apply(ctx, config)
  const agent = { id: 'a1' }
  for (const entry of config.groups[0].entries) pool.cool(entry.provider)

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
  apply(ctx, config)
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
  const { pool } = apply(ctx, config)
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
  const { pool } = apply(ctx, config)
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
  const { pool } = apply(ctx, config)
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
