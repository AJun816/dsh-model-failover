// 视觉工具真调冒烟：apply() 注册 → execute（懒 spawn @z_ai/mcp-server）
import { apply } from '../lib/index.js'
const captured = { search: null, reader: null, tools: [], logs: [], disposers: [] }
const ctx = {
  web: {
    registerSearchProvider: (p) => { captured.search = p; return () => {} },
    registerFetchProvider: (p) => { captured.reader = p; return () => {} },
  },
  get: (name) => (name === 'tools' ? { register: (d) => { captured.tools.push(d); return () => {} } } : undefined),
  effect: (fn) => { captured.disposers.push(fn); return () => {} },
  logger: { info: (...a) => captured.logs.push(a.join(' ')) },
  inject: () => {},
}
apply(ctx, { apiKeyEnvs: ['ZAI_CODING_CN_API_KEY', 'ZAI_CODING_CN_2_API_KEY', 'ZAI_CODING_CN_3_API_KEY'] })
const visionTools = captured.tools.filter((t) => t.name.startsWith('glm_vision_'))
console.log('V1 vision tools registered:', visionTools.length, '(expect 8)')
const tool = visionTools.find((t) => t.name === 'glm_vision_analyze_image')
if (tool === undefined) { console.log('V1 FAIL'); process.exit(1) }
const started = Date.now()
try {
  const { existsSync } = await import('node:fs')
  const localImage = existsSync('/tmp/vision-test.png') ? '/tmp/vision-test.png' : 'https://docs.bigmodel.cn/logo.png'
  const r = await tool.execute(
    { image_source: localImage, prompt: '用一句话描述这张图片的内容' },
    {},
  )
  const ok = typeof r?.text === 'string' && r.text.length > 10
  console.log('V2 analyze_image live call:', ok ? 'PASS' : 'FAIL', '|', ((Date.now() - started) / 1000).toFixed(1) + 's |', (r?.text ?? '').slice(0, 120).replace(/\n/g, ' '))
} catch (e) {
  console.log('V2 FAIL:', e?.wireCode ?? '', e?.message ?? e)
  process.exitCode = 1
} finally {
  for (const d of captured.disposers) d()
  console.log('V3 dispose clean')
  process.exit(process.exitCode ?? 0)
}
