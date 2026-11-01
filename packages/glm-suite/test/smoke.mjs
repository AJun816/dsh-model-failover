/**
 * 真 key 冒烟测试（独立于 cordis 运行）：
 *   node test/smoke.mjs [query]
 * key 来源：环境变量，或回退直读 ~/.dsh/.credentials.yaml（credentialFromFile）。
 * 期望演示：池 = [key1(已触顶 1310), key2] → 搜索自动轮换到 key2 成功；
 * reader 抓取文档页；zread 读 vitejs/vite 目录。
 */
import { KeyPool } from '../lib/keypool.js'
import { credentialFromFile } from '../lib/credentials.js'
import { ZhipuSearchProvider, mapZhipuResults, decodeWebSearchPrime } from '../lib/search.js'
import { ZhipuReaderProvider } from '../lib/reader.js'
import { RemoteMcp } from '../lib/mcp.js'

const REFS = ['ZAI_CODING_CN_API_KEY', 'ZAI_CODING_CN_2_API_KEY', 'ZAI_CODING_CN_3_API_KEY']
const resolveKey = async (ref) => process.env[ref] ?? credentialFromFile(ref)
const log = (...a) => console.log('[smoke]', ...a)

const pool = new KeyPool(REFS)
const options = () => ({
  pool, resolveKey,
  contentSize: 'medium', recencyFilter: 'noLimit', location: 'cn',
  graceMs: 5 * 60_000, enabled: true, log,
})

let failures = 0

// 1) 搜索：多 key 轮换
try {
  const provider = new ZhipuSearchProvider(options)
  console.log('search available:', provider.available())
  const result = await provider.search({ query: process.argv[2] ?? 'GLM-5.3' })
  console.log(`SEARCH ok: ${result.sources.length} sources`)
  for (const s of result.sources.slice(0, 3)) console.log('  -', s.title?.slice(0, 60), '|', s.url)
  console.log('pool after search:', pool.describe())
} catch (error) {
  failures += 1
  console.error('SEARCH FAIL:', error?.code ?? '', error?.message ?? error)
  console.log('pool state:', pool.describe())
}

// 2) 网页读取
try {
  const reader = new ZhipuReaderProvider(options)
  const page = await reader.fetch({ url: 'https://docs.bigmodel.cn/cn/coding-plan/mcp/search-mcp-server' })
  console.log(`READER ok: status=${page.statusCode} kind=${page.body.kind} chars=${page.body.content.length}`)
} catch (error) {
  failures += 1
  console.error('READER FAIL:', error?.code ?? '', error?.message ?? error)
}

// 3) zread（直接走 RemoteMcp，key2）
try {
  const key = await resolveKey('ZAI_CODING_CN_2_API_KEY') ?? await resolveKey('ZAI_CODING_CN_3_API_KEY')
  if (key === undefined) throw new Error('no usable key for zread')
  const mcp = new RemoteMcp('https://open.bigmodel.cn/api/mcp/zread/mcp')
  const result = await mcp.callTool(key, 'get_repo_structure', { repo_name: 'vitejs/vite' })
  const text = result?.content?.[0]?.text ?? ''
  console.log(`ZREAD ok: ${text.slice(0, 120).replace(/\n/g, ' ')}...`)
} catch (error) {
  failures += 1
  console.error('ZREAD FAIL:', error?.wireCode ?? '', error?.message ?? error)
}

console.log(failures === 0 ? 'SMOKE PASS' : `SMOKE DONE with ${failures} failure(s)`)
process.exitCode = failures === 0 ? 0 : 1
