/**
 * 智谱远程 MCP（Streamable HTTP）极简客户端：initialize → notifications/initialized
 * → tools/call。会话 id 按 API key 维度缓存；会话失效自动重建一次。
 *
 * 错误形态两手抓：
 * 1. 非 JSON-RPC 业务信封 {code, msg}（如未鉴权 1001）；
 * 2. tools/call 的 isError 结果：content[0].text = 'MCP error -429: {"error":{"code":"1310",...}}'。
 * 两者统一抛 ZhipuMcpError（带 wireCode），供 KeyPool 分类轮换。
 */

/** 解析 SSE / 纯 JSON 混合响应体为 JSON 值数组。 */
export function parseMcpPayload(body) {
  const trimmed = body.trim()
  if (trimmed.length === 0) return []
  if (!trimmed.includes('data:')) {
    try { return [JSON.parse(trimmed)] } catch { return [] }
  }
  const payloads = []
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload.length === 0) continue
    try { payloads.push(JSON.parse(payload)) } catch { /* keep-alive 等非 JSON 行 */ }
  }
  return payloads
}

/** 双层 JSON 解码：parse 一次得 string 再 parse 一次（失败则保留首次结果）。 */
export function decodeDoubleJson(text) {
  let value
  try { value = JSON.parse(text) } catch { return undefined }
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { /* 保留首次 */ }
  }
  return value
}

/** 从 tools/call isError 文本中提取内层业务错误 {code, message}。 */
export function extractToolError(result) {
  if (result?.isError !== true) return undefined
  const blocks = Array.isArray(result?.content) ? result.content : []
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    const m = /MCP error\s+-?\d+\s*:\s*(\{.*\})\s*$/s.exec(block.text)
    if (m !== null) {
      try {
        const inner = JSON.parse(m[1])
        const code = inner?.error?.code ?? inner?.code
        const message = inner?.error?.message ?? inner?.msg ?? inner?.message
        if (code !== undefined) return { code: String(code), message: String(message ?? '') }
      } catch { /* fallthrough */ }
    }
    // 形态二（本地 stdio 视觉服务器实测）：业务错误 JSON 内嵌在普通错误文本里，
    // 如 'Error: ... HTTP 429: {"error":{"code":"1310","message":"..."}}'
    const embeddedCode = /"code"\s*:\s*"(\d{3,4})"/.exec(block.text)
    if (embeddedCode !== null) {
      const embeddedMessage = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(block.text)
      let message = embeddedMessage !== null ? embeddedMessage[1] : block.text.slice(0, 300)
      try { message = JSON.parse('"' + message + '"') } catch { /* keep raw */ }
      return { code: embeddedCode[1], message }
    }
    return { code: 'TOOL_ERROR', message: block.text.slice(0, 300) }
  }
  return { code: 'TOOL_ERROR', message: 'tool call failed without text content' }
}

/** 远程 MCP 错误：wireCode 为智谱业务码（'1310' 等），供池分类。 */
export class ZhipuMcpError extends Error {
  constructor(message, wireCode, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'ZhipuMcpError'
    this.wireCode = wireCode
    this.httpStatus = options.httpStatus
    this.sessionExpired = options.sessionExpired === true
  }
}

/** 单个端点的会话化客户端。线程安全（模块内串行）；按 key 缓存 session id。 */
export class RemoteMcp {
  #url
  #userAgent
  #timeoutMs
  /** @type {Map<string, string>} apiKey → mcp-session-id */
  #sessions = new Map()

  constructor(url, { userAgent = 'dsh-glm-suite/0.2.0', timeoutMs = 60_000 } = {}) {
    this.#url = url
    this.#userAgent = userAgent
    this.#timeoutMs = timeoutMs
  }

  /** 一次 JSON-RPC POST。 */
  async #post(apiKey, body, signal, extraHeaders = {}) {
    const timeout = AbortSignal.timeout(this.#timeoutMs)
    const combined = signal !== undefined && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, timeout])
      : timeout
    let response
    try {
      response = await fetch(this.#url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'user-agent': this.#userAgent,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: combined,
      })
    } catch (error) {
      if (signal?.aborted === true) throw new ZhipuMcpError('aborted', 'ABORTED', { cause: error })
      throw new ZhipuMcpError(`request failed: ${String(error?.message ?? error)}`, 'TRANSPORT', { cause: error })
    }
    let sessionId
    const header = response.headers.get('mcp-session-id')
    if (header !== null) {
      for (const part of header.split(',')) {
        const v = part.trim()
        if (v.length > 0) sessionId = v
      }
    }
    let text
    try { text = await response.text() } catch (error) {
      throw new ZhipuMcpError(`response read failed: ${String(error?.message ?? error)}`, 'TRANSPORT', { cause: error })
    }
    return { status: response.status, sessionId, payloads: parseMcpPayload(text) }
  }

  /** 业务信封（{code,msg} 且无 jsonrpc 字段）→ 错误。 */
  #businessError(payload, status) {
    const message = typeof payload?.msg === 'string' && payload.msg.length > 0
      ? payload.msg
      : `MCP endpoint error (HTTP ${status})`
    return new ZhipuMcpError(`zhipu MCP: ${message}`, String(payload?.code ?? 'UNKNOWN'), { httpStatus: status })
  }

  /** 建立会话（某 key 首次或失效后）。 */
  async #ensureSession(apiKey, signal) {
    const existing = this.#sessions.get(apiKey)
    if (existing !== undefined) return existing
    const init = await this.#post(apiKey, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'dsh-glm-suite', version: '0.2.0' },
      },
    }, signal)
    const failure = init.payloads.find((p) => p && typeof p === 'object' && typeof p.msg === 'string' && p.msg.length > 0 && p.jsonrpc === undefined)
    if (failure !== undefined) throw this.#businessError(failure, init.status)
    const welcome = init.payloads.find((p) => p?.result?.serverInfo !== undefined || p?.result?.protocolVersion !== undefined)
    if (init.sessionId === undefined || welcome === undefined) {
      throw new ZhipuMcpError('endpoint returned no MCP session (not streamable-HTTP?)', 'TRANSPORT', { httpStatus: init.status })
    }
    this.#sessions.set(apiKey, init.sessionId)
    await this.#post(apiKey, { jsonrpc: '2.0', method: 'notifications/initialized' }, signal, { 'mcp-session-id': init.sessionId })
    return init.sessionId
  }

  /**
   * 调用一个工具并返回 JSON-RPC result（未解码 content）。
   * 会话过期自动重建一次；业务错误统一抛 ZhipuMcpError。
   */
  async callTool(apiKey, name, args, signal) {
    for (let attempt = 0; ; attempt += 1) {
      const sessionId = await this.#ensureSession(apiKey, signal)
      const call = await this.#post(apiKey, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name, arguments: args },
      }, signal, { 'mcp-session-id': sessionId })
      const failure = call.payloads.find((p) => p && typeof p === 'object' && typeof p.msg === 'string' && p.msg.length > 0 && p.jsonrpc === undefined)
      if (failure !== undefined) throw this.#businessError(failure, call.status)
      const result = call.payloads.find((p) => p?.id === 2 && p.result !== undefined)
      if (result === undefined) {
        const rpcError = call.payloads.find((p) => p?.id === 2 && p.error !== undefined)
        if (rpcError !== undefined) {
          const message = String(rpcError.error?.message ?? '')
          const expired = rpcError.error?.code === -32001 || /session/i.test(message) || call.status === 404
          if (expired && attempt === 0) {
            this.#sessions.delete(apiKey)
            continue
          }
          throw new ZhipuMcpError(`rpc error: ${message}`, 'RPC', { httpStatus: call.status, sessionExpired: expired })
        }
        throw new ZhipuMcpError('no tools/call result in response', 'TRANSPORT', { httpStatus: call.status })
      }
      const toolError = extractToolError(result.result)
      if (toolError !== undefined) {
        throw new ZhipuMcpError(`tool ${name}: ${toolError.message}`, toolError.code, { httpStatus: 200 })
      }
      return result.result
    }
  }
}
