/**
 * 凭据解析：三层兜底，key 永不进入日志/配置/错误信息。
 *
 * 1. DSH credentials 服务（ctx.get('credentials').resolve(ref) → {value}）
 * 2. 进程环境变量（桌面应用启动环境）
 * 3. 直读 $DSH_HOME/.credentials.yaml 的 refs 段（无 YAML 依赖的行级解析，
 *    仅支持常见标量写法——与官方凭据文件格式一致）
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CREDENTIALS_FILE = '.credentials.yaml'

/** DSH 主目录：非空白 $DSH_HOME，否则 ~/.dsh（与官方 resolveDshHome 语义一致）。 */
export function dshHome() {
  const envHome = process.env.DSH_HOME
  if (envHome !== undefined && envHome.trim().length > 0) return envHome
  return join(homedir(), '.dsh')
}

/** 从凭据文件 refs 段读取一个标量值；文件缺失/键不存在返回 undefined。 */
export function credentialFromFile(ref, home = dshHome()) {
  try {
    const lines = readFileSync(join(home, CREDENTIALS_FILE), 'utf8').split(/\r?\n/)
    let inRefs = false
    for (const line of lines) {
      if (!inRefs) {
        if (/^refs:\s*(?:#.*)?$/.test(line)) inRefs = true
        continue
      }
      if (line.length > 0 && !/^\s/.test(line)) break
      const match = line.match(/^\s+([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
      if (match === null || match[1] !== ref) continue
      let value = match[2]
      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        try { value = JSON.parse(value) } catch { value = value.slice(1, -1) }
      } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
        value = value.slice(1, -1).replace(/''/g, "'")
      } else {
        value = value.replace(/\s+#.*$/, '').trim()
      }
      return value.length > 0 ? value : undefined
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 构造 ref → key 的解析函数（绑定 DSH 上下文）。
 * @param {object} ctx cordis 上下文（可能无 credentials 服务——独立测试场景）
 */
export function makeResolver(ctx) {
  return async function resolveApiKey(ref) {
    try {
      const credentials = ctx?.get?.('credentials')
      if (credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function') {
        const hit = await credentials.resolve(ref)
        if (typeof hit?.value === 'string' && hit.value.length > 0) return hit.value
      }
    } catch { /* 服务缺席或失败：继续兜底 */ }
    const ambient = process.env[ref]
    if (typeof ambient === 'string' && ambient.length > 0) return ambient
    return credentialFromFile(ref)
  }
}
