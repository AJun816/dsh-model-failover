/**
 * ZhipuReaderProvider —— ctx.web 抓取后端（webReader 套餐 MCP）。
 * provider id：zhipu-reader。key 池全耗尽时回退本地受限 HTTP 抓取，
 * 保证 web_fetch 永不因套餐窗口而死。
 */
import { KeyPool, classifyCode } from './keypool.js'
import { RemoteMcp, ZhipuMcpError, decodeDoubleJson } from './mcp.js'
import { webError } from './search.js'

export const ZHIPU_READER_PROVIDER_ID = 'zhipu-reader'
export const ZHIPU_DEFAULT_READER_MCP_URL = 'https://open.bigmodel.cn/api/mcp/web_reader/mcp'
const MCP_TOOL_NAME = 'webReader'
/** 正文截断上限（字符），对齐 tool-web 的抓取输出预算。 */
const MAX_CONTENT_CHARS = 200_000
/** 本地兜底抓取的超时与体积上限。 */
const LOCAL_TIMEOUT_MS = 30_000
const LOCAL_MAX_BYTES = 4 * 1024 * 1024
const LOCAL_MAX_REDIRECTS = 3

/** webReader result → {title, url, content}（双层数字编码）。 */
export function decodeWebReader(result) {
  const blocks = Array.isArray(result?.content) ? result.content : []
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    const value = decodeDoubleJson(block.text)
    if (value !== null && typeof value === 'object' && typeof value.content === 'string') {
      return {
        title: typeof value.title === 'string' ? value.title : undefined,
        url: typeof value.url === 'string' ? value.url : undefined,
        content: value.content,
      }
    }
    if (typeof value === 'string' && value.length > 0) return { content: value }
  }
  return undefined
}

/** 本地受限 HTTP(S) 抓取（兜底）：跟随有限跳转、限时限体、html/text 两种正文。 */
export async function localHttpFetch(request, signal) {
  let current = String(request.url ?? '')
  for (let hop = 0; hop <= LOCAL_MAX_REDIRECTS; hop += 1) {
    const parsed = URL.parse(current)
    if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      throw webError('local fetch only supports http(s) URLs', 'WEB_FETCH_UNSUPPORTED')
    }
    const timeout = AbortSignal.timeout(LOCAL_TIMEOUT_MS)
    const combined = signal !== undefined && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, timeout])
      : timeout
    let response
    try {
      response = await fetch(current, { method: 'GET', redirect: 'manual', signal: combined })
    } catch (error) {
      if (signal?.aborted === true) throw webError('local fetch aborted', 'WEB_ABORTED')
      throw webError(`local fetch failed: ${String(error?.message ?? error)}`, 'WEB_PROVIDER_ERROR')
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (location === null || hop === LOCAL_MAX_REDIRECTS) {
        throw webError('local fetch: too many redirects', 'WEB_FETCH_REDIRECT')
      }
      current = new URL(location, current).toString()
      continue
    }
    const contentType = String(response.headers.get('content-type') ?? '').toLowerCase()
    const textual = contentType.length === 0 || /^text\//.test(contentType) || /html|json|xml|markdown|yaml|csv/.test(contentType)
    if (!textual) {
      // 二进制内容不做文本解码（对齐官方 http provider 的 unsupported 语义），改走智谱 webReader
      throw webError('local fetch: unsupported content type "' + (contentType || 'unknown') + '" (binary); the GLM webReader backend or a dedicated tool should handle it', 'WEB_FETCH_UNSUPPORTED')
    }
    const bytes = new Uint8Array(await response.arrayBuffer().catch((error) => {
      throw webError(`local fetch body failed: ${String(error?.message ?? error)}`, 'WEB_PROVIDER_ERROR')
    }))
    if (bytes.byteLength > LOCAL_MAX_BYTES) {
      throw webError('local fetch: body too large', 'WEB_FETCH_TOO_LARGE')
    }
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    const kind = contentType.includes('html') ? 'html' : 'text'
    const capped = raw.length > MAX_CONTENT_CHARS
    return {
      url: current,
      statusCode: response.status,
      body: { kind, content: capped ? raw.slice(0, MAX_CONTENT_CHARS) : raw },
      truncated: capped,
    }
  }
  throw webError('local fetch: redirect budget exhausted', 'WEB_FETCH_REDIRECT')
}

/**
 * @param {object} deps 同 ZhipuSearchProvider 的 options thunk，另含 enabled 映射 fetch 开关。
 */
export class ZhipuReaderProvider {
  #options
  #mcp

  constructor(options) {
    this.#options = options
    this.#mcp = new RemoteMcp(ZHIPU_DEFAULT_READER_MCP_URL, { userAgent: 'dsh-glm-suite/0.2.1' })
    this.id = ZHIPU_READER_PROVIDER_ID
  }

  /** 配置端点变化时重建客户端（会话缓存随之更换）。 */
  #ensureMcp(options) {
    if (this.#mcp.url !== options.readerMcpURL) {
      this.#mcp = new RemoteMcp(options.readerMcpURL, { userAgent: 'dsh-glm-suite/0.2.1' })
    }
    return this.#mcp
  }

  available() {
    const options = this.#options()
    return options.enabled === true
  }

  async fetch(request, signal) {
    const options = this.#options()
    if (options.enabled !== true) {
      throw webError('zhipu reader disabled by config', 'WEB_PROVIDER_ERROR')
    }
    const url = URL.parse(String(request.url ?? ''))
    if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      throw webError('webReader only supports http(s) URLs', 'WEB_FETCH_UNSUPPORTED')
    }
    const pool = options.pool
    for (let attempt = 0; attempt <= pool.refs.length; attempt += 1) {
      const [ref] = pool.healthy()
      if (ref === undefined) break
      const apiKey = await options.resolveKey(ref)
      if (apiKey === undefined || apiKey.length === 0) {
        pool.markMissing(ref)
        continue
      }
      try {
        const result = await this.#ensureMcp(options).callTool(apiKey, MCP_TOOL_NAME, { url: request.url }, signal)
        const decoded = decodeWebReader(result)
        if (decoded === undefined) {
          throw new ZhipuMcpError('webReader returned no decodable content', 'EMPTY')
        }
        const content = decoded.content
        const capped = content.length > MAX_CONTENT_CHARS
        return {
          url: decoded.url ?? request.url,
          statusCode: 200,
          body: { kind: 'text', content: capped ? content.slice(0, MAX_CONTENT_CHARS) : content },
          truncated: capped,
        }
      } catch (error) {
        if (signal?.aborted === true) throw webError('zhipu reader aborted', 'WEB_ABORTED')
        if (error instanceof ZhipuMcpError && error.wireCode !== 'ABORTED') {
          const verdict = classifyCode(error.wireCode, error.message, Date.now(), options.graceMs)
          if (verdict.action === 'fail') {
            // 参数/内容安全类错误：智谱云端拒绝了这个 URL —— 本地兜底值得一试。
            break
          }
          pool.mark(ref, verdict)
          options.log(`reader: key ${ref} ${verdict.action}(${verdict.code}), rotating — pool: ${pool.describe()}`)
          continue
        }
        throw webError(`zhipu reader: ${String(error?.message ?? error)}`, 'WEB_PROVIDER_ERROR')
      }
    }
    // 池耗尽或云端拒绝：本地受限抓取兜底，web_fetch 不死。
    options.log('reader: pool unavailable, falling back to local http fetch')
    return localHttpFetch(request, signal)
  }
}
