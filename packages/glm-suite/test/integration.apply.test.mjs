// apply() 全链路集成测试：桩 ctx + 真实 MCP 端点
import { apply } from '../lib/index.js'
import { credentialFromFile } from '../lib/credentials.js'

const captured = { search: null, reader: null, tools: [], logs: [], disposers: [] }
const ctx = {
  web: {
    registerSearchProvider: (p) => { captured.search = p; return () => {} },
    registerFetchProvider: (p) => { captured.reader = p; return () => {} },
  },
  get: (name) => {
    if (name === 'tools') return { register: (def) => { captured.tools.push(def); return () => {} } }
    return undefined
  },
  effect: (fn) => { captured.disposers.push(fn); return () => {} },
  logger: { info: (...a) => captured.logs.push(a.join(' ')) },
  inject: () => {},
}

const config = {
  apiKeyEnvs: ['ZAI_CODING_CN_API_KEY', 'ZAI_CODING_CN_2_API_KEY', 'ZAI_CODING_CN_3_API_KEY'],
  contentSize: 'medium', recencyFilter: 'noLimit', location: 'cn',
}
apply(ctx, config)

let failures = 0
const check = (name, ok, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''))
  if (!ok) failures += 1
}

// 1) apply() 装配断言
check('T1 search provider 注册 (id=zhipu-official)', captured.search?.id === 'zhipu-official')
check('T2 reader provider 注册 (id=zhipu-reader)', captured.reader?.id === 'zhipu-reader')
const ZREAD_TOOLS = ['glm_zread_search_doc','glm_zread_repo_structure','glm_zread_read_file']
const VISION_TOOLS = ['glm_vision_analyze_image','glm_vision_ui_to_artifact','glm_vision_analyze_video']
check('T3 zread 三工具 + vision 八工具注册', captured.tools.length === 11 && ZREAD_TOOLS.every(n => captured.tools.some(t => t.name === n)) && VISION_TOOLS.every(n => captured.tools.some(t => t.name === n)) && captured.tools.filter(t => t.name.startsWith('glm_vision_')).length === 8, captured.tools.length + ' tools')
check('T4 armed 心跳日志', captured.logs.some(l => l.includes('armed')), captured.logs[0] ?? '')
check('T5 search available()', captured.search?.available() === true)
check('T6 reader available()', captured.reader?.available() === true)

// 2) 全链路驱动（真 key、真端点，经 apply 注册的 provider 实例）
try {
  const r = await captured.search.search({ query: 'dsh-glm-suite integration test', maxResults: 5 })
  check('T7 经 apply 的 search 全链路', r.sources.length > 0, r.sources.length + ' sources, first=' + (r.sources[0]?.url ?? ''))
} catch (e) { check('T7 经 apply 的 search 全链路', false, e.message) }

try {
  const f = await captured.reader.fetch({ url: 'https://example.com/' })
  const viaGlm = f.body.kind === 'text' && f.statusCode === 200
  check('T8 经 apply 的 fetch 全链路', viaGlm || f.statusCode === 200, 'status=' + f.statusCode + ' kind=' + f.body.kind + ' chars=' + f.body.content.length)
} catch (e) { check('T8 经 apply 的 fetch 全链路', false, e.message) }

try {
  const tool = captured.tools.find(t => t.name === 'glm_zread_repo_structure')
  const r = await tool.execute({ repo_name: 'vitejs/vite' }, {})
  check('T9 glm_zread_repo_structure.execute 全链路', typeof r?.text === 'string' && r.text.includes('vitejs'), 'text=' + r.text.slice(0, 50))
} catch (e) { check('T9 zread execute', false, e.message) }

// 3) 卸载路径
try { for (const d of captured.disposers) d(); check('T10 卸载路径无异常', true) } catch (e) { check('T10 卸载路径', false, e.message) }

console.log(failures === 0 ? 'INTEGRATION ALL PASS (10/10)' : 'INTEGRATION FAILURES: ' + failures)
process.exitCode = failures === 0 ? 0 : 1
