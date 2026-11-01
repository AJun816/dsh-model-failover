/**
 * KeyPool —— GLM Coding Plan 多 key 轮换池。
 *
 * 错误分类依据 bigmodel 业务码表（docs.bigmodel.cn/cn/api/api-code.md）：
 * - 窗口类（1308/1310/1314-1321）：消息内含重置时刻"YYYY-MM-DD HH:mm:ss 后可继续使用"，
 *   冷却到该时刻 + 宽限（服务器时区 Asia/Shanghai，UTC+8 无夏令时）。
 * - 瞬时类（1302 并发限流 / 1305 平台过载）：短冷却后可再用。
 * - 永久类（1113 欠费 / 1309 套餐过期 / 1313 公平使用 / 1000/1001/1003 鉴权）：标记失效。
 * - 其余（参数/内容安全等）：与 key 无关，不轮换直接失败。
 */
export const PERMANENT_CODES = new Set(['1113', '1309', '1313', '1000', '1001', '1003'])
export const WINDOW_CODES = new Set(['1308', '1310', '1314', '1315', '1316', '1317', '1318', '1319', '1320', '1321'])
export const TRANSIENT_CODES = new Set(['1302', '1305'])

/**
 * 从业务错误消息中解析重置时刻（Asia/Shanghai）。
 * @returns {number|undefined} epoch ms；无法解析时 undefined。
 */
export function parseResetTime(message) {
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(message ?? ''))
  if (m === null) return undefined
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}+08:00`
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : undefined
}

/**
 * 把业务码 + 消息归类为池动作。
 * @returns {{action:'cooldown',until:number,code:string}|{action:'permanent',code:string}|{action:'fail',code:string}}
 */
export function classifyCode(code, message, now = Date.now(), graceMs = 300_000) {
  const c = String(code ?? '')
  if (WINDOW_CODES.has(c)) {
    const reset = parseResetTime(message)
    if (reset !== undefined && reset > now) return { action: 'cooldown', until: reset + graceMs, code: c }
    return { action: 'cooldown', until: now + 3_600_000, code: c }
  }
  if (TRANSIENT_CODES.has(c)) return { action: 'cooldown', until: now + 60_000, code: c }
  if (PERMANENT_CODES.has(c)) return { action: 'permanent', code: c }
  return { action: 'fail', code: c }
}

/** 供轮换循环使用的池：refs 顺序即优先级，冷却/永久状态跨操作保留。 */
export class KeyPool {
  /** @type {string[]} */
  refs
  /** @type {Map<string, {until?: number, permanent?: boolean, reason?: string}>} */
  #states = new Map()

  constructor(refs = []) {
    this.refs = [...refs]
  }

  /** 配置热更新：替换 refs，保留已有冷却状态。 */
  setRefs(refs) {
    this.refs = [...refs]
  }

  /** 记录一次归类结果。fail 不改状态（与 key 无关）。 */
  mark(ref, verdict) {
    if (verdict.action === 'cooldown') this.#states.set(ref, { until: verdict.until, reason: verdict.code })
    else if (verdict.action === 'permanent') this.#states.set(ref, { permanent: true, reason: verdict.code })
  }

  /** key 缺失（未配置/解析失败）视作永久不可用。 */
  markMissing(ref) {
    this.#states.set(ref, { permanent: true, reason: 'missing' })
  }

  /** 状态已过期则清除（惰性）。 */
  #usable(ref, now) {
    const s = this.#states.get(ref)
    if (s === undefined) return true
    if (s.permanent === true) return false
    if ((s.until ?? 0) <= now) {
      this.#states.delete(ref)
      return true
    }
    return false
  }

  /** 当前可用的 refs（保持配置顺序）。 */
  healthy(now = Date.now()) {
    return this.refs.filter((ref) => this.#usable(ref, now))
  }

  /** 人类可读的状态描述（进日志/错误消息；不含 key 值）。 */
  describe(now = Date.now()) {
    return this.refs
      .map((ref) => {
        const s = this.#states.get(ref)
        if (s === undefined) return `${ref}:ok`
        if (s.permanent === true) return `${ref}:dead(${s.reason ?? '?'})`
        return `${ref}:cooldown(${s.reason ?? '?'}→${new Date(s.until).toISOString()})`
      })
      .join(' ')
  }
}
