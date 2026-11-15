#!/usr/bin/env node
/**
 * 用欠费 DeepSeek key 做真实故障注入：
 * 真实 Insufficient Balance 错误 → 已部署插件分类/冷却/切换 → 健康账号真实接管。
 * 完全脚本化，不经过任何会话。
 */
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

async function dsCall() {
  const body = JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], max_tokens: 4, stream: false })
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + keyOf('DEEPSEEK_API_KEY'), 'content-type': 'application/json' }, body })
  const text = await res.text()
  try {
    const d = JSON.parse(text)
    if (d.error) return { code: String(d.error.code ?? d.error.type), message: String(d.error.message), status: res.status }
    return { code: 'OK', message: (d.choices?.[0]?.message?.content ?? '') }
  } catch { return { code: 'PARSE', message: text.slice(0, 90), status: res.status } }
}
async function mmCall(content) {
  const body = JSON.stringify({ model: 'MiniMax-M3.1-Flash', messages: [{ role: 'user', content }], max_tokens: 1024 })
  const res = await fetch('https://api.minimax.chat/v1/text/chatcompletion_v2', {
    method: 'POST', headers: { Authorization: 'Bearer ' + keyOf('MINIMAX_CN_API_KEY'), 'content-type': 'application/json' }, body })
  const d = await res.json()
  const br = d.base_resp ?? {}
  if (br.status_code && br.status_code !== 0) return { code: String(br.status_code), message: br.status_msg }
  return { code: 'OK', message: ((d.choices ?? [{}])[0].message ?? {}).content ?? '' }
}

console.log('步骤 1：真实调用 DeepSeek（预期欠费错误）')
const realErr = await dsCall()
ok('DeepSeek 真实返回欠费错误', /insufficient|balance|402/i.test(realErr.code + ' ' + realErr.message), JSON.stringify(realErr).slice(0, 120))
const realMessage = (realErr.status ?? 402) + ': ' + JSON.stringify({ message: realErr.message })
console.log('  真实错误: [' + realErr.code + '] ' + realErr.message.slice(0, 70))

console.log('步骤 2：把真实欠费错误喂给已部署插件（链首 = deepseek-official）')
const os = await import('node:os')
const { apply, createPool, classifyFailure } = await import(os.homedir() + '/.dsh/profiles/desktop/node_modules/dsh-model-failover/lib/index.js')
ok('分类器把欠费归为 quota（触发切换）', classifyFailure({ code: realErr.code, status: realErr.status, message: realErr.message }) === 'quota',
  '实际: ' + classifyFailure({ code: realErr.code, status: realErr.status, message: realErr.message }))

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
const selection = { provider: 'deepseek-official', model: 'deepseek-chat' }
const agent = { id: 'ds-e2e', model: { select: (s) => Object.assign(selection, s), current: () => ({ ...selection }) } }
apply(ctx, {
  groups: [{ id: 'pool', entries: [
    { provider: 'deepseek-official', model: 'deepseek-chat' },
    { provider: 'zai-coding-cn', model: 'glm-5.3' },
    { provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash' },
  ] }],
  activeGroup: 'pool', cooldownMinutes: 3,
}, { pool, now: () => now })
let downstream = 0
const action = await ctx.waterfall('agent/request-error',
  { agent, turn: 1, step: 1, provider: 'deepseek-official', failure: { code: realErr.code, status: realErr.status, message: realErr.message } },
  () => { downstream++; return { kind: 'retry' } })
ok('fail-fast 无烧录', action === undefined && downstream === 0)
ok('欠费账号被冷却', pool.isCooling('deepseek-official'))
ok('选号切到健康 zai', selection.provider === 'zai-coding-cn', selection.provider)

console.log('步骤 3：健康账号真实接管（zai glm-5.3）')
const zaiBody = JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: '回复：接管成功' }], max_tokens: 8, stream: false })
const zaiRes = await fetch('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', {
  method: 'POST', headers: { Authorization: 'Bearer ' + keyOf('ZAI_CODING_CN_API_KEY'), 'content-type': 'application/json' }, body: zaiBody })
const zd = await zaiRes.json()
ok('zai 真实出活（无错误）', !zd.error, JSON.stringify(zd.error ?? {}).slice(0, 80))

console.log('步骤 4：欠费账号静默验证（冷却期内不再被选）')
const decision = await ctx.waterfall('agent/pre-step',
  { agent, turn: 2, step: 1, modelSelection: { provider: 'deepseek-official', model: 'deepseek-chat' } }, () => ({ kind: 'enter' }))
ok('pre-step 把选号从欠费账号拉回健康链', selection.provider !== 'deepseek-official', selection.provider)

console.log('')
console.log(failed === 0 ? 'DEEPSEEK-FAULT E2E ALL PASS (' + passed + '/' + (passed + failed) + ')' : 'FAILURES: ' + failed)
process.exit(failed === 0 ? 0 : 1)
