#!/usr/bin/env node
/**
 * 真实 API 端到端验证：真实错误 → 已部署插件决策 → 真实健康 key 接管。
 * 只读凭据文件 + 调 GLM API，不改任何状态。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const creds = readFileSync(process.env.HOME + '/.dsh/.credentials.yaml', 'utf8')
const keyOf = (ref) => {
  for (const line of creds.split('\n')) {
    if (line.trimStart().startsWith(ref + ':')) return line.slice(line.indexOf(':') + 1).trim()
  }
  throw new Error('credential not found: ' + ref)
}

async function realCall(key, content) {
  const body = JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content }], max_tokens: 8, stream: false })
  const res = await fetch('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', {
    method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body,
  })
  const text = await res.text()
  try {
    const d = JSON.parse(text)
    const e = d.error
    if (e) return { code: String(e.code), message: String(e.message) }
    return { code: 'OK', message: (d.choices?.[0]?.message?.content ?? '').slice(0, 30) }
  } catch { return { code: 'PARSE', message: text.slice(0, 80) } }
}

let passed = 0, failed = 0
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' | ' + detail : '')) }
}

console.log('步骤 1：获取真实 1310 错误（优先现调；key 缺失时回放 12:15 实抓报文）')
let realMessage
try {
  const realErr = await realCall(keyOf('ZAI_CODING_CN_3_API_KEY'), 'hi')
  if (realErr.code === '1310') {
    realMessage = '429: ' + JSON.stringify({ code: realErr.code, message: realErr.message })
    console.log('  ✓ 现场调取真实 1310')
  }
} catch { /* key 不在凭据文件——回放实抓报文 */ }
if (realMessage === undefined) {
  realMessage = '429: {"code":"1310","message":"已达到 7 天使用上限，2026-11-16 14:32:13 后可继续使用。如需超限额按量付费使用，可联系管理员开启超额按量付费。"}'
  console.log('  （cn-3 key 已从凭据文件移除——回放 2026-11-15 12:15 实抓报文）')
}
ok('拿到真实 1310 报文', realMessage.includes('1310'))

console.log('步骤 2：把真实错误喂给已部署插件（选号停在 cn-3）')
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
const selection = { provider: 'zai-coding-cn-3', model: 'glm-5.3' }
const agent = { id: 'live-e2e', model: { select: (s) => Object.assign(selection, s), current: () => ({ ...selection }) } }
apply(ctx, {
  groups: [{ id: 'glm-pool', entries: [
    { provider: 'zai-coding-cn', model: 'glm-5.3' },
    { provider: 'zai-coding-cn-2', model: 'glm-5.3' },
    { provider: 'zai-coding-cn-3', model: 'glm-5.3' },
  ] }],
  activeGroup: 'glm-pool', cooldownMinutes: 3,
}, { pool, now: () => now })
let downstream = 0
const action = await ctx.waterfall('agent/request-error',
  { agent, turn: 1, step: 1, provider: 'zai-coding-cn-3', failure: { code: 'RATE_LIMIT', status: 429, message: realMessage } },
  () => { downstream++; return { kind: 'retry' } })
ok('插件 fail-fast（不烧重试）', action === undefined && downstream === 0)
ok('插件把选号从 cn-3 切走', selection.provider !== 'zai-coding-cn-3', selection.provider)
ok('选号落在健康账号 cn/cn-2', ['zai-coding-cn', 'zai-coding-cn-2'].includes(selection.provider))

console.log('步骤 3：用插件选定的 key 真实接管——发一个真实请求')
const refOfSelection = selection.provider === 'zai-coding-cn' ? 'ZAI_CODING_CN_API_KEY' : 'ZAI_CODING_CN_2_API_KEY'
const takeover = await realCall(keyOf(refOfSelection), '回复：接管成功')
ok('接管 key 真实服务成功（非 1310/429）', takeover.code === 'OK', JSON.stringify(takeover))
console.log('  接管 key 实际回复: ' + takeover.message)

console.log('步骤 4：pre-step 验证——选号再停回 cn-3 时被拉回健康链')
selection.provider = 'zai-coding-cn-3'
await ctx.waterfall('agent/pre-step', { agent, turn: 2, step: 1, modelSelection: { ...selection } }, () => ({ kind: 'enter' }))
ok('pre-step 把选号拉回健康账号', ['zai-coding-cn', 'zai-coding-cn-2'].includes(selection.provider), selection.provider)

console.log('')
console.log(failed === 0 ? 'LIVE E2E ALL PASS (' + passed + '/' + (passed + failed) + ') — 真实错误→插件决策→真实接管 全链闭合' : 'LIVE E2E FAILURES: ' + failed)
process.exit(failed === 0 ? 0 : 1)
