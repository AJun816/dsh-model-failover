/**
 * glm_zread_* 三件仓库工具（zread 套餐 MCP）：
 *   glm_zread_search_doc     搜索仓库文档/issue/commit
 *   glm_zread_repo_structure 仓库目录结构
 *   glm_zread_read_file      读取仓库内单文件
 *
 * 经 ctx.tools.register 原生注册（JSON Schema 参数 + text 输出契约 + generic 卡片），
 * 与模型工具目录原生融合；zread 关闭时执行期显式报 ZHIPU_DISABLED。
 * 工具名带 glm_ 前缀，与社区插件的 github_* 命名错开，可共存。
 */
import { classifyCode } from './keypool.js'
import { RemoteMcp, ZhipuMcpError, decodeDoubleJson } from './mcp.js'

export const ZHIPU_DEFAULT_ZREAD_MCP_URL = 'https://open.bigmodel.cn/api/mcp/zread/mcp'
const ZREAD_TIMEOUT_MS = 60_000
const REPO_NAME_PATTERN = /^[\w.-]+\/[\w.-]+$/
const OUTPUT_SCHEMA = { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } }

function parseRepoName(value) {
  const repo = typeof value === 'string' ? value.trim() : ''
  if (!REPO_NAME_PATTERN.test(repo)) {
    throw new Error('repo_name must look like "owner/repo"')
  }
  return repo
}

function parseNonEmpty(name, value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) throw new Error(`${name} must be a non-empty string`)
  return text
}

/** 把 tools/call content 合并为单段文本（适配 zread 的单层字符串编码）。 */
export function contentText(result) {
  const blocks = Array.isArray(result?.content) ? result.content : []
  const parts = []
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    const value = decodeDoubleJson(block.text)
    parts.push(typeof value === 'string' ? value : block.text)
  }
  return parts.join('\n')
}

/** 工具规格表（名称/描述/参数 schema/参数解析）。 */
export function zreadToolSpecs() {
  return [
    {
      name: 'glm_zread_search_doc',
      description: 'Search documentation, issues, and commits of a GitHub repository (GLM Coding Plan zread MCP). repo_name must be "owner/repo".',
      properties: {
        repo_name: { type: 'string', description: 'GitHub repository: owner/repo (e.g. "vitejs/vite")' },
        query: { type: 'string', description: 'Search keywords or a question about the repository.' },
        language: { type: 'string', description: "'zh' or 'en' (match the conversation language)" },
      },
      required: ['repo_name', 'query'],
      parse: (args) => ({
        repo_name: parseRepoName(args?.repo_name),
        query: parseNonEmpty('query', args?.query),
        language: args?.language === 'zh' || args?.language === 'en' ? args.language : undefined,
        title: `zread search ${parseRepoName(args?.repo_name)}`,
      }),
      tool: 'search_doc',
    },
    {
      name: 'glm_zread_repo_structure',
      description: 'Get the directory structure and file list of a GitHub repository (GLM Coding Plan zread MCP). repo_name must be "owner/repo".',
      properties: {
        repo_name: { type: 'string', description: 'GitHub repository: owner/repo (e.g. "vitejs/vite")' },
        dir_path: { type: 'string', description: 'Directory path to inspect (default: root "/")' },
      },
      required: ['repo_name'],
      parse: (args) => ({
        repo_name: parseRepoName(args?.repo_name),
        dir_path: typeof args?.dir_path === 'string' && args.dir_path.trim().length > 0 ? args.dir_path.trim() : '/',
        title: `zread structure ${parseRepoName(args?.repo_name)}`,
      }),
      tool: 'get_repo_structure',
    },
    {
      name: 'glm_zread_read_file',
      description: 'Read the full code content of one file in a GitHub repository (GLM Coding Plan zread MCP). repo_name must be "owner/repo".',
      properties: {
        repo_name: { type: 'string', description: 'GitHub repository: owner/repo (e.g. "vitejs/vite")' },
        file_path: { type: 'string', description: 'Relative path of the file (e.g. "src/index.ts")' },
      },
      required: ['repo_name', 'file_path'],
      parse: (args) => ({
        repo_name: parseRepoName(args?.repo_name),
        file_path: parseNonEmpty('file_path', args?.file_path),
        title: `zread file ${parseRepoName(args?.repo_name)}`,
      }),
      tool: 'read_file',
    },
  ]
}

/**
 * 注册三件工具。tools 服务缺席（如极简组合）时静默跳过，返回空数组。
 * @param {object} ctx cordis 上下文
 * @param {() => {pool: object, resolveKey: Function, zreadMcpURL: string, enabled: boolean,
 *   graceMs: number, log: Function}} getOptions
 * @returns {(() => void)[]} 卸载函数列表
 */
export function registerZreadTools(ctx, getOptions) {
  const tools = (() => { try { return ctx.get('tools') } catch { return undefined } })()
  if (tools === undefined || tools === null || typeof tools.register !== 'function') return []
  const mcp = new RemoteMcp(ZHIPU_DEFAULT_ZREAD_MCP_URL, { userAgent: 'dsh-glm-suite/0.2.0', timeoutMs: ZREAD_TIMEOUT_MS })
  const disposers = []
  for (const spec of zreadToolSpecs()) {
    const definition = {
      name: spec.name,
      description: spec.description,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: spec.required,
        properties: spec.properties,
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      timeoutMs: ZREAD_TIMEOUT_MS,
      isConcurrencySafe: () => true,
      presentCall: (args) => {
        try {
          const parsed = spec.parse(args)
          return { card: 'generic', title: parsed.title, kind: 'fetch', rawInput: args }
        } catch {
          return undefined
        }
      },
      execute: async (args, exec) => {
        const options = getOptions()
        if (options.enabled !== true) {
          throw Object.assign(new Error('[ZHIPU_DISABLED] glm_zread_* tools are disabled (glm-suite config zread:false)'), { code: 'ZHIPU_DISABLED' })
        }
        const parsed = spec.parse(args)
        const signal = exec?.signal
        const pool = options.pool
        const errors = []
        for (let attempt = 0; attempt <= pool.refs.length; attempt += 1) {
          const [ref] = pool.healthy()
          if (ref === undefined) break
          const apiKey = await options.resolveKey(ref)
          if (apiKey === undefined || apiKey.length === 0) {
            pool.markMissing(ref)
            continue
          }
          try {
            const result = await mcp.callTool(apiKey, spec.tool, parsed, signal)
            const text = contentText(result)
            if (text.length === 0) {
              throw new ZhipuMcpError(`zread ${spec.tool} returned empty content`, 'EMPTY')
            }
            return { text }
          } catch (error) {
            if (error instanceof ZhipuMcpError) {
              const verdict = classifyCode(error.wireCode, error.message, Date.now(), options.graceMs)
              if (verdict.action === 'fail') throw new Error(`glm_zread: ${error.message}`, { cause: error })
              pool.mark(ref, verdict)
              options.log(`zread: key ${ref} ${verdict.action}(${verdict.code}), rotating — pool: ${pool.describe()}`)
              errors.push(`${ref}:${verdict.code}`)
              continue
            }
            throw error
          }
        }
        throw new Error(`glm_zread: all keys unavailable (${errors.join(', ') || 'no usable key'}) — pool: ${pool.describe()}`)
      },
    }
    disposers.push(tools.register(definition))
  }
  return disposers
}
