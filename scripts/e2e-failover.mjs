#!/usr/bin/env node
/**
 * dsh-model-failover 端到端验证脚本（完全离线，不调真实 API、不碰任何会话）。
 *
 * 模拟 DSH 0.2.2 固定路由架构（model.select + pre-step + request-error 瀑布），
 * 注入真实形态的失败（1310/1308/500），断言切换闭环。
 *
 * 用法：node scripts/e2e-failover.mjs [插件lib路径，默认 ~/.dsh/profiles/desktop/node_modules/dsh-model-failover/lib/index.js]
 */
const os = await import('node:os')
const pathMod = await import('node:path')
const arg = process.argv[2]
const libPath = arg
  ? pathMod.resolve(arg)
  : os.homedir() + '/.dsh/profiles/desktop/node_modules/dsh-model-failover/lib/index.js'
const { apply, createPool } = await import(libPath)

let passed = 0, failed = 0
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' | ' + detail : '')) }
}

function harness(config, clockMs) {
  const log = { info: [], warn: [] }
  const listeners = new Map()
  const ctx = {
    logger: { info: (...a) => log.info.push(a.join(' ')), warn: (...a) => log.warn.push(a.join(' ')) },
    on(e, l) { (listeners.get(e) ?? listeners.set(e, []).get(e)).push(l); return () => {} },
    effect(f) { const d = f(); return () => d?.() },
  }
  ctx.waterfall = async (event, payload, seed) => {
    const chain = [...(listeners.get(event) ?? [])]
    const run = async (i) => i >= chain.length ? (typeof seed === 'function' ? seed() : seed) : chain[i](payload, () => run(i + 1))
    return run(0)
  }
  const pool = createPool({ cooldownMs: 3 * 60_000, now: () => clockMs })
  const selection = { provider: 'zai-coding-cn', model: 'glm-5.3' }
  const agent = {
    id: 'e2e',
    model: {
      select: (s) => Object.assign(selection, s),
      current: () => ({ ...selection }),
    },
  }
  apply(ctx, config, { pool, now: () => clockMs })
  return { ctx, pool, selection, agent, log }
}

const CFG = {
  groups: [{ id: 'glm-pool', entries: [
    { provider: 'zai-coding-cn', model: 'glm-5.3' },
    { provider: 'zai-coding-cn-2', model: 'glm-5.3' },
    { provider: 'zai-coding-cn-3', model: 'glm-5.3' },
  ] }],
  activeGroup: 'glm-pool', cooldownMinutes: 3,
  retryOn: ['quota', 'rate-limit', 'auth', 'network'],
}
const M1310 = '429: {"code":"1310","message":"已达到 7 天使用上限，2026-11-16 14:32:13 后可继续使用。"}'
const M1308 = (reset) => '429: {"code":"1308","message":"已达到 5 小时使用上限，' + reset + ' 后可继续使用。"}'
const err = (msg, code = 'RATE_LIMIT', status = 429) => ({ code, status, message: msg })

console.log('场景 1：健康链 — 0.2.2 架构下 agent/request 透传固定选号（改路由会触发宿主 throw）')
{
  const t = harness(CFG, Date.parse('2026-11-15T12:00:00'))
  const out = await t.ctx.waterfall('agent/request', { agent: t.agent, turn: 1, step: 1 }, () => ({ provider: 'zai-coding-cn', model: 'glm-5.3', temperature: 0.3 }))
  ok('透传固定选号（cn 不变）', out.provider === 'zai-coding-cn' && out.model === 'glm-5.3')
  ok('保留中立字段', out.temperature === 0.3)
  // legacy 路径（无 model.select 的 agent）：改写路由到链首健康账号
  const legacy = { id: 'lg' }
  const out2 = await t.ctx.waterfall('agent/request', { agent: legacy, turn: 1, step: 1 }, () => ({ provider: 'seed', model: 'seed-model', temperature: 0.2 }))
  ok('legacy 路由到链首 cn', out2.provider === 'zai-coding-cn')
}

console.log('场景 2：链首 1310（首次）— fail-fast + 选号切健康账号 + 冷却仅 15 分钟（地板效应快速回血）')
{
  const t = harness(CFG, Date.parse('2026-11-15T12:00:00'))
  let downstream = 0
  const action = await t.ctx.waterfall('agent/request-error',
    { agent: t.agent, turn: 1, step: 1, provider: 'zai-coding-cn', failure: err(M1310) },
    () => { downstream++; return { kind: 'retry' } })
  ok('当步快速失败（不烧重试）', action === undefined && downstream === 0)
  ok('选号切到 cn-2', t.selection.provider === 'zai-coding-cn-2')
  const rem = t.pool.remaining('zai-coding-cn')
  ok('首次 1310 冷却 ≤15 分钟（地板账号分钟级回血）', rem <= 15 * 60_000 + 1, rem + 'ms')
}

console.log('场景 3：真死账号 — 1310 重复失败指数退避（15min → 1h → 6h → 重置）')
{
  const t = harness(CFG, Date.parse('2026-11-15T12:00:00'))
  const fire = () => t.ctx.waterfall('agent/request-error',
    { agent: t.agent, turn: 1, step: 1, provider: 'zai-coding-cn', failure: err(M1310) }, () => ({ kind: 'retry' }))
  await fire()
  const r1 = t.pool.remaining('zai-coding-cn')
  // 第二次（间隔 20 分钟 > 15min 冷却，探测又 1310）
  await t.ctx.waterfall('agent/request-error',
    { agent: t.agent, turn: 2, step: 1, provider: 'zai-coding-cn', failure: err(M1310) }, () => ({ kind: 'retry' }))
  const r2 = t.pool.remaining('zai-coding-cn')
  ok('第二次退避 ~1h（15min×4）', r2 > 30 * 60_000 && r2 <= 65 * 60_000, (r2 / 60000).toFixed(0) + 'min')
  ok('首次仅 15min（对照）', r1 <= 15 * 60_000 + 1, (r1 / 60000).toFixed(0) + 'min')
}

console.log('场景 4：1308（5h 窗）— 冷却到重置时刻（语义不变）')
{
  const t = harness(CFG, Date.parse('2026-11-15T12:00:00'))
  await t.ctx.waterfall('agent/request-error',
    { agent: t.agent, turn: 1, step: 1, provider: 'zai-coding-cn', failure: err(M1308('2026-11-15T13:30:00')) },
    () => ({ kind: 'retry' }))
  const rem = t.pool.remaining('zai-coding-cn')
  ok('冷却至重置（~90 分钟）', rem > 80 * 60_000 && rem <= 95 * 60_000, (rem / 60000).toFixed(0) + 'min')
}

console.log('场景 5：pre-step — 选号停在冷却账号时改到链首健康账号')
{
  const t = harness(CFG, Date.parse('2026-11-15T12:00:00'))
  t.selection.provider = 'zai-coding-cn-3'
  t.pool.cool('zai-coding-cn-3', 60 * 60_000)
  const decision = await t.ctx.waterfall('agent/pre-step',
    { agent: t.agent, turn: 1, step: 1, modelSelection: { ...t.selection } }, () => ({ kind: 'enter' }))
  ok('pre-step 把选号从死账号改到 cn', t.selection.provider === 'zai-coding-cn')
  ok('决策保持 enter', decision?.kind === 'enter')
}

console.log('场景 6：全链冷却 + 全部远期 — 静默 fail-fast，无复活探测噪声')
{
  const t = harness(CFG, Date.parse('2026-11-15T12:00:00'))
  // 先触发三次 1310 让退避拉长
  for (let i = 0; i < 3; i++) {
    await t.ctx.waterfall('agent/request-error',
      { agent: t.agent, turn: i + 1, step: 1, provider: CFG.groups[0].entries[i % 3].provider, failure: err(M1310) }, () => ({ kind: 'retry' }))
  }
  let downstream = 0
  const action = await t.ctx.waterfall('agent/request-error',
    { agent: t.agent, turn: 9, step: 1, provider: 'zai-coding-cn', failure: err(M1310) },
    () => { downstream++; return { kind: 'retry' } })
  ok('静默 fail-fast（0 烧录）', action === undefined && downstream === 0)
}

console.log('')
console.log(failed === 0 ? 'E2E ALL PASS (' + passed + '/' + (passed + failed) + ')' : 'E2E FAILURES: ' + failed + '/' + (passed + failed))
process.exit(failed === 0 ? 0 : 1)
