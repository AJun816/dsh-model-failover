/**
 * ZhipuSearchProvider —— ctx.web 搜索后端（web_search_prime 套餐 MCP）。
 * provider id：zhipu-official（与旧 dsh-web-search-zhipu 插件保持连续）。
 * 多 key 轮换：1310/1308 等窗口类错误自动冷却换下一把；全耗尽时显式失败
 * （绝不静默回落 DeepSeek 计费——那是本插件要消灭的成本）。
 */
import { KeyPool, classifyCode } from './keypool.js'
import { RemoteMcp, ZhipuMcpError, decodeDoubleJson } from './mcp.js'

export const ZHIPU_PROVIDER_ID = 'zhipu-official'
export const ZHIPU_DEFAULT_SEARCH_MCP_URL = 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp'
const MCP_TOOL_NAME = 'web_search_prime'
/** 智谱限制单条 query ≤70 字符。 */
const MAX_QUERY_CHARS = 70

/** 把 tools/call result 解码为原始结果数组（适配双层数组或 {search_result}/{result} 包裹）。 */
export function decodeWebSearchPrime(result) {
  const blocks = Array.isArray(result?.content) ? result.content : []
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    const value = decodeDoubleJson(block.text)
    if (Array.isArray(value)) return { raw: value }
    if (value !== null && typeof value === 'object') {
      if (Array.isArray(value.search_result)) return { raw: value.search_result }
      if (Array.isArray(value.result)) return { raw: value.result }
    }
  }
  return { raw: [] }
}

/** 原始结果数组 → 缝的 WebSearchSource（按 URL 去重；maxResults 由缝统一截断）。 */
export function mapZhipuResults(raw) {
  const seen = new Set()
  const sources = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const url = typeof item.link === 'string' && item.link.length > 0 ? item.link : undefined
    if (url === undefined || seen.has(url)) continue
    seen.add(url)
    sources.push({
      url,
      ...(typeof item.title === 'string' && item.title.length > 0 ? { title: item.title } : {}),
      ...(typeof item.content === 'string' && item.content.length > 0 ? { snippet: item.content } : {}),
      ...(typeof item.publish_date === 'string' && item.publish_date.length > 0 ? { publishedAt: item.publish_date } : {}),
    })
  }
  return { sources, truncated: false }
}

/**
 * @param {object} deps
 * @param {() => {pool: KeyPool, resolveKey(ref:string): Promise<string|undefined>, searchMcpURL: string,
 *   contentSize: string, recencyFilter: string, location: string, enabled: boolean,
 *   graceMs: number, log(...args: unknown[]): void}} deps.options
 */
export class ZhipuSearchProvider {
  #options
  #mcp

  constructor(options) {
    this.#options = options
    this.#mcp = new RemoteMcp(ZHIPU_DEFAULT_SEARCH_MCP_URL, { userAgent: 'dsh-glm-suite/0.2.0' })
    this.id = ZHIPU_PROVIDER_ID
  }

  available() {
    const options = this.#options()
    return options.enabled === true && options.pool.healthy().length > 0
  }

  async search(request, signal) {
    const options = this.#options()
    if (options.enabled !== true) {
      throw webError('zhipu search disabled by config (fail loud; will not silently bill DeepSeek)', 'WEB_PROVIDER_ERROR')
    }
    const args = {
      search_query: String(request.query ?? '').slice(0, MAX_QUERY_CHARS),
      content_size: options.contentSize,
      location: options.location,
    }
    if (options.recencyFilter !== undefined && options.recencyFilter !== 'noLimit') {
      args.search_recency_filter = options.recencyFilter
    }
    const pool = options.pool
    const errors = []
    for (let attempt = 0; attempt <= pool.refs.length; attempt += 1) {
      const [ref, ...rest] = pool.healthy()
      if (ref === undefined) break
      const apiKey = await options.resolveKey(ref)
      if (apiKey === undefined || apiKey.length === 0) {
        pool.markMissing(ref)
        options.log(`search: key ${ref} missing, rotating`)
        continue
      }
      try {
        const result = await this.#mcp.callTool(apiKey, MCP_TOOL_NAME, args, signal)
        return mapZhipuResults(decodeWebSearchPrime(result).raw)
      } catch (error) {
        if (signal?.aborted === true) throw webError('zhipu search aborted', 'WEB_ABORTED')
        if (error instanceof ZhipuMcpError && error.wireCode !== 'ABORTED') {
          const verdict = classifyCode(error.wireCode, error.message, Date.now(), options.graceMs)
          if (verdict.action === 'fail') throw webError(error.message, 'WEB_PROVIDER_ERROR')
          pool.mark(ref, verdict)
          options.log(`search: key ${ref} ${verdict.action}(${verdict.code}), rotating — pool: ${pool.describe()}`)
          errors.push(`${ref}:${verdict.code}`)
          continue
        }
        throw webError(`zhipu search: ${String(error?.message ?? error)}`, 'WEB_PROVIDER_ERROR')
      }
    }
    throw webError(
      `zhipu search: all keys unavailable (${errors.join(', ') || 'no usable key'}) — pool: ${pool.describe()}. 窗口重置后自动恢复；期间 web_search 显式失败，不回落 DeepSeek 计费`,
      'WEB_PROVIDER_UNAVAILABLE',
    )
  }
}

/** 形状兼容官方 WebError（无法解析 @deepseek-ai/dsh-web 时降级为普通 Error）。 */
let webErrorCtor = class WebErrorLike extends Error {
  constructor(message, code, options) {
    super(message, options)
    this.code = code
  }
}
try {
  const mod = await import('@deepseek-ai/dsh-web')
  if (typeof mod.WebError === 'function') webErrorCtor = mod.WebError
} catch { /* 独立测试环境：形状降级 */ }

export function webError(message, code, options) {
  return new webErrorCtor(message, code, options)
}
