/**
 * dsh-glm-suite —— GLM Coding Plan 套餐能力的 DSH 完整封装。
 *
 * 覆盖套餐 4 个专属 MCP 中的 3 个（对话模型由 llm-pi-ai providers 承担）：
 *   联网搜索  web_search_prime → ctx.web 搜索后端 zhipu-official（多 key 轮换）
 *   网页读取  webReader        → ctx.web 抓取后端 zhipu-reader（本地 http 兜底）
 *   开源仓库  zread            → glm_zread_* 三件原生工具
 *   视觉理解  @z_ai/mcp-server → 建议经官方 dsh-mcp-client 挂载（README 附行）
 *
 * 设计原则：搜索链路绝不静默回落 DeepSeek 计费（窗口耗尽显式失败并给出重置时刻）；
 * 抓取链路池耗尽时本地兜底保证 web_fetch 不死；一切挂载 best-effort，异常等价于未安装。
 */
import z from '@deepseek-ai/schemastery'
import { KeyPool } from './keypool.js'
import { makeResolver } from './credentials.js'
import { ZhipuSearchProvider, ZHIPU_DEFAULT_SEARCH_MCP_URL } from './search.js'
import { ZhipuReaderProvider, ZHIPU_DEFAULT_READER_MCP_URL } from './reader.js'
import { registerZreadTools, ZHIPU_DEFAULT_ZREAD_MCP_URL } from './zread.js'
import { registerVisionTools, DEFAULT_VISION_ARGS } from './vision.js'

/** cordis 插件名（patch 行 id 用小写短名）。 */
export const name = 'glm-suite'
/** 注入 web 缝（provider 注册面）；tools 经 ctx.get 惰性获取（缺席时降级）。 */
export const inject = ['web']

const SETTINGS_NAMESPACE = 'glm-suite'
export const DEFAULT_KEY_POOL = [
  'ZAI_CODING_CN_API_KEY',
  'ZAI_CODING_CN_2_API_KEY',
  'ZAI_CODING_CN_3_API_KEY',
]

export const Config = z.object({
  search: z.boolean().default(true).description('接管 web_search 后端（web_search_prime 套餐 MCP）'),
  fetch: z.boolean().default(true).description('接管 web_fetch 后端（webReader 套餐 MCP；池耗尽本地兜底）'),
  zread: z.boolean().default(true).description('注册 glm_zread_* 三件仓库工具'),
  vision: z.boolean().default(true).description('注册 glm_vision_* 八件视觉工具（本地 @z_ai/mcp-server，懒启动）'),
  visionCommand: z.string().default('npx').description('视觉 MCP 启动命令（宿主 PATH 极简时可用绝对路径）'),
  visionArgs: z.array(z.string()).default(DEFAULT_VISION_ARGS),
  visionTimeoutMs: z.number().default(120_000).description('视觉工具单次调用超时'),
  apiKeyEnvs: z.array(z.string()).role('credential-ref').default(DEFAULT_KEY_POOL).description('key 池（credential 引用名，顺序即优先级；1310/1308 触顶自动轮换）'),
  searchMcpURL: z.string().default(ZHIPU_DEFAULT_SEARCH_MCP_URL),
  readerMcpURL: z.string().default(ZHIPU_DEFAULT_READER_MCP_URL),
  zreadMcpURL: z.string().default(ZHIPU_DEFAULT_ZREAD_MCP_URL),
  contentSize: z.string().default('medium').description('搜索摘要字数：medium（400-600字）/ high（2500字，积分更高）'),
  recencyFilter: z.string().default('noLimit').description('oneDay/oneWeek/oneMonth/oneYear/noLimit'),
  location: z.string().default('cn').description('搜索区域偏好 cn/us'),
  cooldownGraceMinutes: z.number().default(5).description('窗口类错误冷却在重置时刻之上的宽限分钟数'),
})

/** 心跳日志：armed 状态可观测（对齐 model-failover 的教训——插件是否生效必须能从日志看出）。 */
function makeLogger(ctx) {
  return (...args) => {
    try {
      if (ctx?.logger && typeof ctx.logger.info === 'function') {
        ctx.logger.info('glm-suite:', ...args)
        return
      }
    } catch { /* fallthrough */ }
    try { console.log('[glm-suite]', ...args) } catch { /* noop */ }
  }
}

export function apply(ctx, config) {
  const log = makeLogger(ctx)
  let current = config ?? {}
  const pool = new KeyPool(Array.isArray(current.apiKeyEnvs) && current.apiKeyEnvs.length > 0 ? current.apiKeyEnvs : DEFAULT_KEY_POOL)
  const resolveKey = makeResolver(ctx)

  const options = () => ({
    pool,
    resolveKey,
    searchMcpURL: current.searchMcpURL ?? ZHIPU_DEFAULT_SEARCH_MCP_URL,
    readerMcpURL: current.readerMcpURL ?? ZHIPU_DEFAULT_READER_MCP_URL,
    zreadMcpURL: current.zreadMcpURL ?? ZHIPU_DEFAULT_ZREAD_MCP_URL,
    contentSize: current.contentSize ?? 'medium',
    recencyFilter: current.recencyFilter ?? 'noLimit',
    location: current.location ?? 'cn',
    graceMs: (current.cooldownGraceMinutes ?? 5) * 60_000,
    enabled: current.search !== false,
    log,
  })
  const readerOptions = () => ({ ...options(), enabled: current.fetch !== false })
  const zreadOptions = () => ({ ...options(), enabled: current.zread !== false })
  const visionOptions = () => ({
    ...options(),
    enabled: current.vision !== false,
    visionCommand: current.visionCommand ?? 'npx',
    visionArgs: current.visionArgs ?? DEFAULT_VISION_ARGS,
    visionTimeoutMs: current.visionTimeoutMs ?? 120_000,
  })

  // 配置面：0.2.x 的 settings 服务从插件 Config schema 自动派生表单（无需手动注册）；
  // GUI/YAML 改动经 cordis 生命周期重载插件（apply 重建，池冷却在首次失败时自愈重建）。
  // options() 每次操作即时快照 current，覆盖 apply 后被原地替换 config 对象的路径。

  // web 缝 provider 注册（重复 id 冲突时放弃接管，等价于本插件未装，不阻塞宿主）。
  try {
    const disposeSearch = ctx.web.registerSearchProvider(new ZhipuSearchProvider(options))
    ctx.effect(() => () => { try { disposeSearch() } catch { /* noop */ } })
  } catch (error) {
    log('search provider registration skipped:', String(error?.message ?? error))
  }
  try {
    const disposeReader = ctx.web.registerFetchProvider(new ZhipuReaderProvider(readerOptions))
    ctx.effect(() => () => { try { disposeReader() } catch { /* noop */ } })
  } catch (error) {
    log('reader provider registration skipped:', String(error?.message ?? error))
  }

  // glm_zread_* 工具注册（tools 服务缺席时静默跳过）。
  let zreadDisposers = []
  try {
    zreadDisposers = registerZreadTools(ctx, zreadOptions)
  } catch (error) {
    log('zread tools registration skipped:', String(error?.message ?? error))
  }
  if (zreadDisposers.length > 0) {
    ctx.effect(() => () => { for (const dispose of zreadDisposers) { try { dispose() } catch { /* noop */ } } })
  }

  // glm_vision_* 视觉工具（本地 stdio MCP 懒启动；tools 服务缺席时静默跳过）。
  let visionDisposers = []
  try {
    visionDisposers = registerVisionTools(ctx, visionOptions)
  } catch (error) {
    log('vision tools registration skipped:', String(error?.message ?? error))
  }
  if (visionDisposers.length > 0) {
    ctx.effect(() => () => { for (const dispose of visionDisposers) { try { dispose() } catch { /* noop */ } } })
  }

  function heartbeat() {
    log(
      `armed search=${current.search !== false ? 'zhipu-official' : 'off'}`,
      `fetch=${current.fetch !== false ? 'zhipu-reader' : 'off'}`,
      `zread=${current.zread !== false ? '3-tools' : 'off'}`,
      `vision=${current.vision !== false ? '8-tools' : 'off'}`,
      `pool(${pool.refs.length})=${pool.refs.join(',')}`,
      `state=${pool.describe()}`,
    )
  }
  heartbeat()
}
