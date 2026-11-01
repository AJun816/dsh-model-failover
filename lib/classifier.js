/**
 * Failure classification and provider exclusion.
 *
 * The classifier maps an LlmFailure onto a small set of switch-driving
 * classes. Code wins, HTTP status follows, message keywords are the last
 * resort — every rule here exists because a real provider emitted it.
 *
 * @module dsh-model-failover/classifier
 */
/** Failure classes that can trigger a switchover. */
export const FAILURE_CLASSES = ['quota', 'rate-limit', 'auth', 'network', 'other'];
const CODE_CLASS = [
    [/^(ACCOUNT_)?QUOTA$/i, 'quota'],
    [/RATE_LIMIT/i, 'rate-limit'],
    [/^AUTH(ORIZATION|ENTICATION)?$/i, 'auth'],
    [/^(NETWORK|TIMEOUT|CONNECTION)/i, 'network'],
];
const MESSAGE_CLASS = [
    [/insufficient\s+balance|quota|额度|余额|使用上限|usage\s*limit/i, 'quota'],
    [/rate\s*limit|too many requests|限流|请求过于频繁|稍后(再试|重试)/i, 'rate-limit'],
    [/invalid\s+api\s*key|unauthorized|forbidden|authentication/i, 'auth'],
    // Channel verification blocks (WorkBuddy-style reverse-engineered upstreams:
    // HTTP 400 code 11128 "Illegal API invocation from an unapproved channel",
    // retry:false). Auth-class so the provider is cooled down and skipped.
    [/unapproved\s+channel|illegal\s+api\s+invocation/i, 'auth'],
    [/network|econnreset|econnrefused|etimedout|fetch failed|timeout|overload|服务繁忙/i, 'network'],
];
const STATUS_CLASS = new Map([
    [402, 'quota'], [429, 'rate-limit'], [401, 'auth'], [403, 'auth'],
    [503, 'network'], [504, 'network'], [529, 'network'],
]);
/**
 * Parse a provider-stated resume time like "2026-11-05 17:10:49 后可继续使用"
 * (weekly/period usage caps) into remaining milliseconds. Local time assumed.
 */
export function retryAfterFromMessage(message, now = Date.now()) {
    if (typeof message !== 'string' || message === '')
        return 0;
    const hit = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(:\d{2})?)/.exec(message);
    if (hit === null)
        return 0;
    const time = hit[3] === undefined ? hit[2] + ':00' : hit[2];
    const until = Date.parse(hit[1] + 'T' + time);
    return Number.isFinite(until) ? Math.max(0, until - now) : 0;
}
/**
 * Classify an LlmFailure into one of the failure classes. Code wins, message
 * keywords and HTTP status follow.
 */
export function classifyFailure(failure) {
    if (failure === null || failure === undefined || typeof failure !== 'object')
        return 'other';
    const code = String(failure.code ?? '');
    for (const [pattern, klass] of CODE_CLASS)
        if (pattern.test(code))
            return klass;
    // A numeric string code ("429", "1310"-style HTTP echoes) maps like a status.
    const numeric = /^\d{3}$/.test(code) ? Number(code) : undefined;
    const statusHit = STATUS_CLASS.get(failure.status ?? numeric ?? NaN);
    if (statusHit !== undefined)
        return statusHit;
    if (/^13[0-9]{2}$/.test(code))
        return code === '1302' ? 'rate-limit' : 'quota';
    const message = String(failure.message ?? '');
    for (const [pattern, klass] of MESSAGE_CLASS)
        if (pattern.test(message))
            return klass;
    return 'other';
}
/**
 * True when a provider id matches a catalogExclude pattern. A pattern is an
 * exact id ("workbuddy-ai") or a prefix wildcard ("workbuddy-*"); empty and
 * malformed patterns never match.
 */
export function providerExcluded(patterns, provider) {
    if (!Array.isArray(patterns))
        return false;
    for (const raw of patterns) {
        if (typeof raw !== 'string' || raw.length === 0)
            continue;
        const pattern = raw.trim();
        if (pattern.length === 0)
            continue;
        if (pattern.endsWith('*')) {
            const prefix = pattern.slice(0, -1);
            if (provider.startsWith(prefix))
                return true;
        }
        else if (provider === pattern) {
            return true;
        }
    }
    return false;
}
