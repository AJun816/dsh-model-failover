/** 纯逻辑单元测试（node --test，无网络、无 key）。 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseResetTime, classifyCode, KeyPool } from '../lib/keypool.js'
import { parseMcpPayload, decodeDoubleJson, extractToolError } from '../lib/mcp.js'
import { decodeWebSearchPrime, mapZhipuResults } from '../lib/search.js'
import { decodeWebReader } from '../lib/reader.js'
import { contentText } from '../lib/zread.js'

test('parseResetTime 解析 1310 消息中的重置时刻（Asia/Shanghai）', () => {
  const t = parseResetTime('已达到 7 天使用上限，2026-11-05 17:10:49 后可继续使用。')
  assert.equal(typeof t, 'number')
  assert.equal(new Date(t).toISOString(), '2026-11-05T09:10:49.000Z') // UTC+8
  assert.equal(parseResetTime('no time here'), undefined)
})

test('classifyCode：窗口/瞬时/永久/失败四类', () => {
  const now = Date.parse('2026-11-01T00:00:00+08:00')
  const w = classifyCode('1310', 'x 2026-11-05 17:10:49 后', now, 0)
  assert.equal(w.action, 'cooldown')
  assert.equal(w.until, Date.parse('2026-11-05T17:10:49+08:00'))
  assert.equal(classifyCode('1302', '', now).action, 'cooldown')
  assert.equal(classifyCode('1309', '', now).action, 'permanent')
  assert.equal(classifyCode('1113', '', now).action, 'permanent')
  assert.equal(classifyCode('1210', '', now).action, 'fail')
  assert.equal(classifyCode('1301', '', now).action, 'fail')
})

test('KeyPool：冷却过期自动恢复，setRefs 保留状态', () => {
  const pool = new KeyPool(['a', 'b', 'c'])
  const now = Date.now()
  pool.mark('a', { action: 'cooldown', until: now + 1000, code: '1310' })
  pool.mark('b', { action: 'permanent', code: '1309' })
  assert.deepEqual(pool.healthy(now), ['c'])
  // describe 在过期探测之前展示冷却/永久状态（healthy 会惰性清除过期项）
  assert.match(pool.describe(now), /a:cooldown/)
  assert.match(pool.describe(now), /b:dead/)
  assert.deepEqual(pool.healthy(now + 2000), ['a', 'c'])
  pool.setRefs(['c', 'd'])
  assert.deepEqual(pool.healthy(now), ['c', 'd'])
  assert.doesNotMatch(pool.describe(now), /a:/) // 已移出池的 ref 不再展示
})

test('parseMcpPayload：纯 JSON 与 SSE 两种响应体', () => {
  assert.deepEqual(parseMcpPayload('{"code":1001,"msg":"no auth"}'), [{ code: 1001, msg: 'no auth' }])
  const sse = 'event:message\ndata:{"jsonrpc":"2.0","id":1,"result":{"x":1}}\n\ndata:keep-alive'
  assert.deepEqual(parseMcpPayload(sse), [{ jsonrpc: '2.0', id: 1, result: { x: 1 } }])
  assert.deepEqual(parseMcpPayload(''), [])
})

test('decodeDoubleJson：双层编码一次解开', () => {
  const raw = JSON.stringify(JSON.stringify([{ title: 'a' }]))
  assert.deepEqual(decodeDoubleJson(raw), [{ title: 'a' }])
  assert.equal(decodeDoubleJson(JSON.stringify('plain text')), 'plain text')
  assert.equal(decodeDoubleJson('not json'), undefined)
})

test('extractToolError：从 isError 文本提取内层业务码', () => {
  const inner = JSON.stringify({ error: { code: '1310', message: '已达到 7 天使用上限，2026-11-05 17:10:49 后可继续使用' } })
  const result = { isError: true, content: [{ type: 'text', text: `MCP error -429: ${inner}` }] }
  const e = extractToolError(result)
  assert.equal(e.code, '1310')
  assert.match(e.message, /7 天使用上限/)
  assert.equal(extractToolError({ isError: false, content: [] }), undefined)
  // 本地视觉服务器形态：业务 JSON 内嵌在普通错误文本中
  const embedded = extractToolError({
    isError: true,
    content: [{ type: 'text', text: 'Error: Unexpected error: analyze-image analysis failed: HTTP 429: {"error":{"code":"1310","message":"You have reached the 7-day usage limit. You can continue using it after 2026-11-05 17:10:49."}}' }],
  })
  assert.equal(embedded.code, '1310')
  assert.match(embedded.message, /7-day usage limit/)
})

test('decodeWebSearchPrime / mapZhipuResults：智谱双层结果映射与去重', () => {
  const results = [
    { title: 'a', link: 'https://a', content: 'sa', publish_date: '2026-10-01' },
    { title: 'a2', link: 'https://a', content: 'dup' },
    { title: 'b', link: 'https://b' },
  ]
  const payload = { content: [{ type: 'text', text: JSON.stringify(JSON.stringify(results)) }] }
  const decoded = decodeWebSearchPrime(payload)
  assert.equal(decoded.raw.length, 3)
  const mapped = mapZhipuResults(decoded.raw)
  assert.deepEqual(mapped.sources.map((s) => s.url), ['https://a', 'https://b'])
  assert.equal(mapped.sources[0].publishedAt, '2026-10-01')
  assert.equal(mapped.truncated, false)
})

test('decodeWebReader：{title,url,content} 解码', () => {
  const page = { title: 'T', url: 'https://x', content: '正文' }
  const payload = { content: [{ type: 'text', text: JSON.stringify(JSON.stringify(page)) }] }
  const d = decodeWebReader(payload)
  assert.equal(d.title, 'T')
  assert.equal(d.url, 'https://x')
  assert.equal(d.content, '正文')
})

test('contentText：zread 单层字符串编码合并', () => {
  const payload = { content: [{ type: 'text', text: JSON.stringify('Directory Structure of vitejs/vite') }] }
  assert.equal(contentText(payload), 'Directory Structure of vitejs/vite')
})
