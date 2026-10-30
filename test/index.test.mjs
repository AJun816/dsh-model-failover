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

test('all entries cooling → pass through untouched and surface default error handling', async () => {
  const ctx = fakeCtx()
  const { pool } = apply(ctx, config)
  const agent = { id: 'a1' }
  for (const entry of config.groups[0].entries) pool.cool(entry.provider)

  const out = await ctx.waterfall('agent/request', { agent, turn: 1, step: 1 }, () => seedConfig)
  assert.deepEqual({ provider: out.provider, model: out.model }, { provider: 'seed', model: 'seed-model' })

  const action = await ctx.waterfall(
    'agent/request-error',
    { agent, provider: 'glm-1', failure: { code: 'QUOTA' } },
    () => 'default-error',
  )
  assert.equal(action, 'default-error')
  assert.ok(ctx.log.warn.some((line) => line.includes('every account is cooling')))
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
    else assert.equal(action, 'default-error')
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
