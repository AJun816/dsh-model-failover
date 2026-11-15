#!/usr/bin/env node
/** 混合替补链端到端：zai(1310) → 插件切换 → minimax 真实接管。 */
import { readFileSync } from 'node:fs'

const creds = readFileSync(process.env.HOME + '/.dsh/.credentials.yaml', 'utf8')
const keyOf = (ref) => {
  for (const line of creds.split('\n')) {
    if (line.trimStart().startsWith(ref + ':')) return line.slice(line.indexOf(':') + 1).trim()
  }
  throw new Error('credential not found: ' + ref)
}

let passed = 0, failed = 0
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' | ' + detail : '')) }
}

// 真实 MiniMax 调用（chatcompletion_v2）
async function mmCall(content) {
  // M3.x 是推理模型：小 max_tokens 会被思考耗尽、正文为空——给足预算
  const body = JSON.stringify({ model: 'MiniMax-M3.1-Flash', messages: [{ role: 'user', content }], max_tokens: 1024 })
  const res = await fetch('https://api.minimax.chat/v1/text/chatcompletion_v2', {
    method: 'POST', headers: { Authorization: 'Bearer ' + keyOf('MINIMAX_CN_API_KEY'), 'content-type': 'application/json' }, body })
  const text = await res.text()
  try {
    const d = JSON.parse(text)
    const br = d.base_resp ?? {}
    if (br.status_code && br.status_code !== 0) return { code: String(br.status_code), message: br.status_msg }
    return { code: 'OK', message: ((d.choices ?? [{}])[0].message ?? {}).content ?? '' }
  } catch { return { code: 'PARSE', message: text.slice(0, 90) } }
}

console.log('步骤 1：MiniMax 替补健康检查（真实调用）')
const health = await mmCall('回复两个字：正常')
ok('MiniMax-M3.1-Flash 真实可用', health.code === 'OK', JSON.stringify(health))

console.log('步骤 2：混合链 [zai-coding-cn, minimax-cn] — 注入真实 1310 给 zai')
const os = await import('node:os')
const { apply, createPool } = await import(os.homedir() + '/.dsh/profiles/desktop/node_modules/dsh-model-failover/lib/index.js')
const listeners = new Map()
const log = { info: [], warn: [] }
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
const now = Date.now()
const pool = createPool({ cooldownMs: 3 * 60_000, now: () => now })
const selection = { provider: 'zai-coding-cn', model: 'glm-5.3' }
const agent = { id: 'mix-e2e', model: { select: (s) => Object.assign(selection, s), current: () => ({ ...selection }) } }
apply(ctx, {
  groups: [{ id: 'glm-pool', entries: [
    { provider: 'zai-coding-cn', model: 'glm-5.3' },
    { provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash' },
  ] }],
  activeGroup: 'glm-pool', cooldownMinutes: 3,
}, { pool, now: () => now })
const real1310 = '429: {"code":"1310","message":"已达到 7 天使用上限，2026-11-16 14:32:13 后可继续使用。"}'
let downstream = 0
const action = await ctx.waterfall('agent/request-error',
  { agent, turn: 1, step: 1, provider: 'zai-coding-cn', failure: { code: 'RATE_LIMIT', status: 429, message: real1310 } },
  () => { downstream++; return { kind: 'retry' } })
ok('fail-fast 无烧录', action === undefined && downstream === 0)
ok('选号切到 minimax-cn', selection.provider === 'minimax-cn', selection.provider)
ok('模型跟随替补条目', selection.model === 'MiniMax-M3.1-Flash', selection.model)

console.log('步骤 3：替补真实接管（MiniMax 完成一次真实请求）')
const takeover = await mmCall('回复：替补接管成功')
ok('MiniMax 真实出活', takeover.code === 'OK' && (takeover.message || '').length > 0, JSON.stringify(takeover))
console.log('  MiniMax 实际回复: ' + takeover.message)

console.log(failed === 0 ? 'MIXED-CHAIN E2E ALL PASS (' + passed + '/' + (passed + failed) + ')' : 'MIXED-CHAIN FAIL: ' + failed)
process.exit(failed === 0 ? 0 : 1)
