/**
 * glm_vision_* 八件视觉工具 —— 本地 stdio MCP `@z_ai/mcp-server` 的原生桥接。
 *
 * 懒启动：首次调用才 spawn（npx 冷启动数秒，不拖累宿主启动）；
 * key 池联动：子进程 env 注入 Z_AI_API_KEY（凭据服务解析），配额类错误冷却换号自动重启子进程；
 * 工具 schema 来自 zai-mcp-server v0.1.5 实测 tools/list（官方文档的 image_analysis/video_analysis
 * 实际名为 analyze_image/analyze_video，以服务器为准）。
 */
import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { classifyCode } from './keypool.js'
import { ZhipuMcpError, extractToolError } from './mcp.js'

export const DEFAULT_VISION_ARGS = ['-y', '@z_ai/mcp-server@latest']
const INIT_TIMEOUT_MS = 60_000
/** npx 不在宿主 PATH 时的回退候选目录（macOS 常见安装位 + 运行时位）。 */
const COMMAND_FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']

/** 视觉工具规格（serverName → 本插件注册名 glm_vision_<serverName>）。 */
export const VISION_SPECS = [
  {
    serverName: "ui_to_artifact",
    toolName: "glm_vision_ui_to_artifact",
    description: "Convert UI screenshots into various artifacts: code, prompts, design specifications, or descriptions.\n\nUse this tool ONLY when the user wants to:\n- Generate frontend code from UI design (output_type='code')\n- Create AI prompts for UI generation (output_type='prompt')\n- Extract design specifications (output_type='spec')\n- Get natural language description of the UI (output_type='description')\n\nDo NOT use for: screenshots containing text/code to extract, error messages, diagrams, or data visualizations.",
    inputSchema: {"type":"object","properties":{"image_source":{"type":"string","description":"Local file path or remote URL to the image"},"output_type":{"type":"string","enum":["code","prompt","spec","description"],"description":"Type of output to generate. Options: 'code' (generate frontend code), 'prompt' (generate AI prompt for recreating this UI), 'spec' (generate design specification document), 'description' (natural language description of the UI)."},"prompt":{"type":"string","description":"Detailed instructions describing what to generate from this UI image. Should clearly state the desired output and any specific requirements."}},"required":["image_source","output_type","prompt"],"additionalProperties":false},
  },
  {
    serverName: "extract_text_from_screenshot",
    toolName: "glm_vision_extract_text_from_screenshot",
    description: "Extract and recognize text from screenshots using advanced OCR capabilities.\n\nUse this tool ONLY when the user has a screenshot containing text and wants to extract it.\nThis tool specializes in OCR for code, terminal output, documentation, and general text extraction.\n\nDo NOT use for: UI design conversion, error diagnosis, or diagram understanding.",
    inputSchema: {"type":"object","properties":{"image_source":{"type":"string","description":"Local file path or remote URL to the image"},"prompt":{"type":"string","description":"Instructions for text extraction. Specify what type of text to extract and any formatting requirements."},"programming_language":{"type":"string","description":"Optional: specify the programming language if the screenshot contains code (e.g., 'python', 'javascript', 'java'). Leave empty for auto-detection or non-code text."}},"required":["image_source","prompt"],"additionalProperties":false},
  },
  {
    serverName: "diagnose_error_screenshot",
    toolName: "glm_vision_diagnose_error_screenshot",
    description: "Diagnose and analyze error messages, stack traces, and exception screenshots.\n\nUse this tool ONLY when the user has an error screenshot and needs help understanding or fixing it.\nThis tool specializes in error analysis and provides actionable solutions.\n\nDo NOT use for: code extraction, UI analysis, or diagram understanding.",
    inputSchema: {"type":"object","properties":{"image_source":{"type":"string","description":"Local file path or remote URL to the image"},"prompt":{"type":"string","description":"Description of what you need help with regarding this error. Include any relevant context about when it occurred."},"context":{"type":"string","description":"Optional: additional context about when the error occurred (e.g., 'during npm install', 'when running the app', 'after deployment'). Helps with more accurate diagnosis."}},"required":["image_source","prompt"],"additionalProperties":false},
  },
  {
    serverName: "understand_technical_diagram",
    toolName: "glm_vision_understand_technical_diagram",
    description: "Analyze and explain technical diagrams including architecture diagrams, flowcharts, UML, ER diagrams, and system design diagrams.\n\nUse this tool ONLY when the user has a technical diagram and wants to understand its structure or components.\nThis tool specializes in interpreting visual technical documentation.\n\nDo NOT use for: UI screenshots, error messages, or data visualizations/charts.",
    inputSchema: {"type":"object","properties":{"image_source":{"type":"string","description":"Local file path or remote URL to the image"},"prompt":{"type":"string","description":"What you want to understand or extract from this diagram."},"diagram_type":{"type":"string","description":"Optional: specify the diagram type if known (e.g., 'architecture', 'flowchart', 'uml', 'er-diagram', 'sequence'). Leave empty for auto-detection."}},"required":["image_source","prompt"],"additionalProperties":false},
  },
  {
    serverName: "analyze_data_visualization",
    toolName: "glm_vision_analyze_data_visualization",
    description: "Analyze data visualizations, charts, graphs, and dashboards to extract insights and trends.\n\nUse this tool ONLY when the user has a data visualization image and wants to understand the data patterns or metrics.\nThis tool specializes in interpreting visual data representations.\n\nDo NOT use for: UI mockups, error messages, or technical architecture diagrams.",
    inputSchema: {"type":"object","properties":{"image_source":{"type":"string","description":"Local file path or remote URL to the image"},"prompt":{"type":"string","description":"What insights or information you want to extract from this visualization."},"analysis_focus":{"type":"string","description":"Optional: specify what to focus on (e.g., 'trends', 'anomalies', 'comparisons', 'performance metrics'). Leave empty for comprehensive analysis."}},"required":["image_source","prompt"],"additionalProperties":false},
  },
  {
    serverName: "ui_diff_check",
    toolName: "glm_vision_ui_diff_check",
    description: "Compare two UI screenshots to identify visual differences and implementation discrepancies.\n\nUse this tool ONLY when the user wants to compare an expected/reference UI with an actual implementation.\nThis tool is specialized for UI quality assurance and design-to-implementation verification.\n\nDo NOT use for: general image comparison, error diagnosis, or analyzing single UIs.",
    inputSchema: {"type":"object","properties":{"expected_image_source":{"type":"string","description":"Local file path or remote URL to the image"},"actual_image_source":{"type":"string","description":"Local file path or remote URL to the image"},"prompt":{"type":"string","description":"Instructions for the comparison. Specify what aspects to focus on or what level of detail is needed."}},"required":["expected_image_source","actual_image_source","prompt"],"additionalProperties":false},
  },
  {
    serverName: "analyze_image",
    toolName: "glm_vision_analyze_image",
    description: "General-purpose image analysis for scenarios not covered by specialized tools.\n\nUse this tool as a FALLBACK when none of the other specialized tools (ui_to_artifact, extract_text_from_screenshot,\ndiagnose_error_screenshot, understand_technical_diagram, analyze_data_visualization, ui_diff_check) fit the user's need.\n\nThis tool provides flexible image understanding for any visual content.",
    inputSchema: {"type":"object","properties":{"image_source":{"type":"string","description":"Local file path or remote URL to the image"},"prompt":{"type":"string","description":"Detailed description of what you want to analyze, extract, or understand from the image. Be specific about your requirements."}},"required":["image_source","prompt"],"additionalProperties":false},
  },
  {
    serverName: "analyze_video",
    toolName: "glm_vision_analyze_video",
    description: "Analyze video content using advanced AI vision models.\n\nUse this tool when the user wants to:\n- Understand what happens in a video\n- Extract key moments or actions from video\n- Analyze video content, scenes, or sequences\n- Get descriptions of video footage\n- Identify objects, people, or activities in video\n\nSupports both local files and remote URL. Maximum file size: 8MB. Supports MP4, MOV, M4V formats.",
    inputSchema: {"type":"object","properties":{"video_source":{"type":"string","description":"Local file path or remote URL to the video (supports MP4, MOV, M4V)"},"prompt":{"type":"string","description":"Detailed text prompt describing what to analyze, extract, or understand from the video"}},"required":["video_source","prompt"],"additionalProperties":false},
  },
]

/** 找可执行文件：先按原样，再试常见目录（Electron 宿主 PATH 可能极简）。 */
function resolveExecutable(command) {
  if (command.includes('/')) return command
  for (const dir of COMMAND_FALLBACK_DIRS) {
    try {
      const candidate = `${dir}/${command}`
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch { /* next */ }
  }
  return command
}

/** 单个 stdio MCP 子进程会话（newline-delimited JSON-RPC）。 */
class StdioMcpSession {
  #proc
  #buffer = ''
  #pending = new Map()
  #nextId = 0

  constructor(command, args, env, timeoutMs) {
    this.timeoutMs = timeoutMs
    this.#proc = spawn(resolveExecutable(command), args, {
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    this.#proc.on('error', (error) => this.#failAll(new ZhipuMcpError(`vision server spawn failed: ${String(error?.message ?? error)}`, 'SPAWN', { cause: error })))
    this.#proc.on('exit', () => this.#failAll(new ZhipuMcpError('vision server exited', 'TRANSPORT')))
    this.#proc.stdout.on('data', (chunk) => this.#onData(chunk))
  }

  #failAll(error) {
    for (const [, reject] of this.#pending) reject(error)
    this.#pending.clear()
  }

  #onData(chunk) {
    this.#buffer += chunk.toString('utf8')
    let index
    while ((index = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, index).trim()
      this.#buffer = this.#buffer.slice(index + 1)
      if (line.length === 0) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (message?.id === undefined) continue
      const pending = this.#pending.get(message.id)
      if (pending !== undefined) {
        this.#pending.delete(message.id)
        pending(message)
      }
    }
  }

  #request(method, params, timeoutMs) {
    const id = ++this.#nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new ZhipuMcpError(`${method} timeout after ${timeoutMs}ms`, 'TIMEOUT'))
      }, timeoutMs)
      this.#pending.set(id, (message) => {
        clearTimeout(timer)
        if (message.error !== undefined) {
          reject(new ZhipuMcpError(`rpc error (${method}): ${String(message.error?.message ?? '')}`, 'RPC'))
          return
        }
        resolve(message)
      })
      try {
        this.#proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(new ZhipuMcpError(`stdin write failed: ${String(error?.message ?? error)}`, 'TRANSPORT', { cause: error }))
      }
    })
  }

  async initialize() {
    const welcome = await this.#request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'dsh-glm-suite', version: '0.2.0' },
    }, INIT_TIMEOUT_MS)
    this.#proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    return welcome?.result?.serverInfo ?? {}
  }

  async call(name, args, timeoutMs) {
    const response = await this.#request('tools/call', { name, arguments: args }, timeoutMs ?? this.timeoutMs)
    const result = response?.result
    if (result === undefined) throw new ZhipuMcpError(`tool ${name}: no result`, 'TRANSPORT')
    const toolError = extractToolError(result)
    if (toolError !== undefined) throw new ZhipuMcpError(`tool ${name}: ${toolError.message}`, toolError.code)
    return result
  }

  kill() {
    this.#failAll(new ZhipuMcpError('vision session disposed', 'ABORTED'))
    try { this.#proc.kill('SIGTERM') } catch { /* noop */ }
    setTimeout(() => { try { this.#proc.kill('SIGKILL') } catch { /* noop */ } }, 3000).unref?.()
  }
}

/**
 * 注册 glm_vision_* 八件工具（懒 spawn；key 池轮换自动重启子进程）。
 * @param {object} ctx cordis 上下文
 * @param {() => {pool: object, resolveKey: Function, enabled: boolean, visionCommand?: string,
 *   visionArgs?: string[], visionTimeoutMs?: number, graceMs: number, log: Function}} getOptions
 * @returns {(() => void)[]} 卸载函数（含子进程清理）
 */
export function registerVisionTools(ctx, getOptions) {
  const tools = (() => { try { return ctx.get('tools') } catch { return undefined } })()
  if (tools === undefined || tools === null || typeof tools.register !== 'function') return []

  /** @type {StdioMcpSession|undefined} */
  let session
  /** @type {string|undefined} 当前子进程绑定的 key 引用名 */
  let boundRef
  let starting = undefined

  async function ensureServer() {
    const options = getOptions()
    if (options.enabled !== true) {
      throw Object.assign(new Error('[ZHIPU_DISABLED] glm_vision_* tools are disabled (glm-suite config vision:false)'), { code: 'ZHIPU_DISABLED' })
    }
    const [ref] = options.pool.healthy()
    if (ref === undefined) {
      throw new Error(`glm_vision: no usable key — pool: ${options.pool.describe()}`)
    }
    if (session !== undefined && boundRef === ref) return session
    if (session !== undefined) session.kill()
    if (starting !== undefined) return starting
    starting = (async () => {
      const apiKey = await options.resolveKey(ref)
      if (apiKey === undefined || apiKey.length === 0) {
        options.pool.markMissing(ref)
        throw new Error(`glm_vision: key ${ref} missing`)
      }
      const command = options.visionCommand ?? 'npx'
      const args = options.visionArgs ?? DEFAULT_VISION_ARGS
      const child = new StdioMcpSession(command, args, {
        ...process.env,
        Z_AI_API_KEY: apiKey,
        Z_AI_MODE: 'ZHIPU',
      }, options.visionTimeoutMs)
      const serverInfo = await child.initialize()
      session = child
      boundRef = ref
      options.log(`vision server up (${serverInfo.name ?? '?'} ${serverInfo.version ?? '?'}) on key ${ref}`)
      return child
    })()
    try {
      return await starting
    } finally {
      starting = undefined
    }
  }

  const disposers = []
  for (const spec of VISION_SPECS) {
    disposers.push(tools.register({
      name: spec.toolName,
      description: spec.description,
      parameters: spec.inputSchema,
      output: {
        schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      timeoutMs: getOptions().visionTimeoutMs,
      isConcurrencySafe: () => true,
      presentCall: (args) => {
        try {
          return { card: 'generic', title: `vision ${spec.serverName}`, kind: 'fetch', rawInput: args }
        } catch {
          return undefined
        }
      },
      execute: async (args, exec) => {
        const options = getOptions()
        for (let attempt = 0; attempt <= options.pool.refs.length; attempt += 1) {
          let child
          try {
            child = await ensureServer()
          } catch (error) {
            if (attempt < options.pool.refs.length && /missing|no usable key/.test(String(error?.message ?? ''))) continue
            throw error
          }
          try {
            const result = await child.call(spec.serverName, args, options.visionTimeoutMs)
            const text = (Array.isArray(result?.content) ? result.content : [])
              .filter((b) => b?.type === 'text')
              .map((b) => b.text)
              .join('\n')
            if (text.length === 0) throw new ZhipuMcpError(`vision ${spec.serverName} returned empty content`, 'EMPTY')
            return { text }
          } catch (error) {
            if (error instanceof ZhipuMcpError) {
              const verdict = classifyCode(error.wireCode, error.message, Date.now(), options.graceMs)
              if (verdict.action !== 'fail') {
                options.pool.mark(boundRef, verdict)
                options.log(`vision: key ${boundRef} ${verdict.action}(${verdict.code}), rotating — pool: ${options.pool.describe()}`)
                if (session !== undefined) { session.kill(); session = undefined; boundRef = undefined }
                continue
              }
            }
            throw error
          }
        }
        throw new Error(`glm_vision: all rotation attempts exhausted — pool: ${options.pool.describe()}`)
      },
    }))
  }
  return [
    () => { if (session !== undefined) { session.kill(); session = undefined; boundRef = undefined } },
    ...disposers,
  ]
}
