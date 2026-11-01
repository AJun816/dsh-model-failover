/**
 * dsh-model-failover — browser half.
 *
 * A Plugins-page card that edits this plugin's `model-failover` settings
 * namespace over the public `remote.settings` wire. Visual language follows
 * the stock Models page: rounded cards, hairline borders, pill status dots.
 * Auto mode (config.groups empty) mirrors the Host: every configured
 * provider joins the chain automatically.
 *
 * @module dsh-model-failover/client
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { VERSION } from './version.js'
import type { CSSProperties, ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { SettingsForm } from '@deepseek-ai/dsh-client-ui-primitives'

interface Entry { provider: string, model: string }
interface Group { id: string, entries: Entry[] }
interface SwitchRecord { at: number, from: string, to: string, reason: string, via: string }

interface FailoverConfig {
  groups?: Group[]
  activeGroup?: string
  cooldownMinutes?: number
  retryOn?: string[]
  autoDiscover?: boolean
  fallbackToCatalog?: boolean
  lastSwitches?: SwitchRecord[]
}
interface NamespaceView { ns: string, value?: FailoverConfig, revision?: number, writable?: boolean }
interface CatalogModel { id: string, name?: string }
interface CatalogGroup { id: string, name?: string, models?: CatalogModel[] }
interface ModelCatalog {
  default?: { provider?: string, model?: string }
  groups?: CatalogGroup[]
  /** Providers the harness can actually route to (wire schema). */
  routableProviders?: readonly string[]
}

const NS = 'model-failover'
const RETRY_CLASSES = ['quota', 'rate-limit', 'auth', 'network']
const RETRY_HINT: Record<string, string> = {
  quota: '额度用尽（402 / 余额不足）',
  'rate-limit': '限流（429）',
  auth: '鉴权失效（401/403）',
  network: '网络 / 供应商宕机（5xx）',
}

/* —— 视觉：对齐 设置→模型 页的圆角卡片与细线 —— */
const surface: CSSProperties = {
  background: 'var(--dsw-alias-surface-secondary, rgba(127,127,127,0.04))',
  borderRadius: 14, padding: 16,
}
const card: CSSProperties = {
  background: 'var(--dsw-alias-surface-primary, transparent)',
  border: '1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.22))',
  borderRadius: 12, padding: '12px 14px',
}
const row: CSSProperties = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }
const sectionTitle: CSSProperties = { margin: '0 0 10px', fontSize: 14, fontWeight: 600 }
const mutedTitle: CSSProperties = { margin: '0 0 2px', fontSize: 13, fontWeight: 600, opacity: 0.75 }
const hint: CSSProperties = { opacity: 0.55, fontSize: 12, margin: '6px 0 0', lineHeight: 1.6 }
const selectStyle: CSSProperties = {
  padding: '6px 10px', borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.22))',
  background: 'var(--dsw-alias-surface-primary, transparent)', color: 'inherit',
}
const dot = (ok: boolean): CSSProperties => ({
  width: 7, height: 7, borderRadius: 999, flexShrink: 0,
  background: ok ? 'var(--dsw-alias-text-success, #22a06b)' : 'var(--dsw-alias-text-tertiary, #999)',
})
const providerCell: CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, minWidth: 210 }

/** One llm-pi-ai provider route profile (secrets travel via credential refs). */
interface RouteProfile {
  apiKeyEnv?: string
  displayName?: string
  api?: string
  baseURL?: string
  models?: { id: string, name?: string }[]
  [key: string]: unknown
}
interface SettingsOp { op: 'set' | 'unset', path: (string | number)[], value?: unknown }

interface RemoteFace {
  settings: {
    describe(): Promise<{ ok: boolean, value?: { namespaces?: NamespaceView[] }, error?: { message?: string } }>
    update(ns: string, value: FailoverConfig, revision?: number): Promise<{ ok: boolean, value?: unknown, error?: { message?: string } }>
    mutate(ns: string, ops: SettingsOp[], revision?: number): Promise<{ ok: boolean, value?: unknown, error?: { message?: string } }>
  }
  session: {
    modelCatalog(): Promise<{ ok: boolean, value?: ModelCatalog, error?: { message?: string } }>
  }
  credentials?: {
    describe(refs: string[]): Promise<{ ok: boolean, value?: Record<string, unknown>, error?: { message?: string } }>
    set(ref: string, value: string): Promise<{ ok: boolean, value?: unknown, error?: { message?: string } }>
    unset(ref: string): Promise<{ ok: boolean, value?: unknown, error?: { message?: string } }>
  }
  llm?: {
    listConfigurableProviders(): Promise<{ ok: boolean, value?: Array<{ provider: string, displayName?: string, defaultBaseURL?: string }>, error?: { message?: string } }>
    discoverModels(ns: string, request: { provider?: string, baseURL?: string }): Promise<{ ok: boolean, value?: Array<{ id: string, name?: string, contextWindow?: number, maxTokens?: number, inputModalities?: string[] }>, error?: { message?: string } }>
  }
}

const PI_AI_NS = 'llm-pi-ai'
/** Same convention as the stock Models page: glm-2 -> GLM_2_API_KEY. */
function deriveKeyRef(route: string): string {
  return route.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY'
}
const ROUTE_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

function sameConfig(a: FailoverConfig, b: FailoverConfig): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))
}
function normalize(c: FailoverConfig): FailoverConfig {
  return {
    groups: (c.groups ?? []).map((g) => ({ id: g.id, entries: (g.entries ?? []).map((e) => ({ provider: e.provider, model: e.model })) })),
    activeGroup: c.activeGroup ?? '',
    cooldownMinutes: c.cooldownMinutes ?? 30,
    retryOn: [...(c.retryOn ?? [])].sort(),
    autoDiscover: c.autoDiscover ?? true,
    // Host 写入的切换记录随保存原样透传，避免被覆盖丢失
    ...(c.lastSwitches !== undefined ? { lastSwitches: c.lastSwitches } : {}),
  }
}
function invalidReasons(c: FailoverConfig): string[] {
  const problems: string[] = []
  for (const group of c.groups ?? []) {
    if ((group.id ?? '').trim() === '') problems.push('存在未命名的分组')
    for (const [i, entry] of (group.entries ?? []).entries()) {
      if (entry.provider.trim() === '' || entry.model.trim() === '') {
        problems.push('分组 "' + group.id + '" 第 ' + (i + 1) + ' 条不完整')
      }
    }
  }
  if ((c.cooldownMinutes ?? 30) < 1) problems.push('冷却时长至少 1 分钟')
  return problems
}

function FailoverCard(props: { view?: string, remote?: RemoteFace }): ReactNode {
  const [saved, setSaved] = useState<FailoverConfig | null>(null)
  const [draft, setDraft] = useState<FailoverConfig | null>(null)
  const [revision, setRevision] = useState<number | undefined>(undefined)
  const [writable, setWritable] = useState(true)
  const [notice, setNotice] = useState<{ failed: boolean, text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  /** llm-pi-ai provider routes (the account pool this card manages). */
  const [routes, setRoutes] = useState<Record<string, RouteProfile> | null>(null)
  const [piAiRevision, setPiAiRevision] = useState<number | undefined>(undefined)
  /** Which credential refs have a stored value, by ref name. */
  const [credConfigured, setCredConfigured] = useState<Record<string, boolean>>({})
  /** llm configurable-provider directory (defaultBaseURL per vendor). */
  const [providerDir, setProviderDir] = useState<Array<{ provider: string, displayName?: string, defaultBaseURL?: string }> | null>(null)
  /** 当前默认模型（agent-default-model 命名空间）。 */
  const [defaultModel, setDefaultModel] = useState<{ provider?: string, model?: string } | null>(null)
  const [admRevision, setAdmRevision] = useState<number | undefined>(undefined)
  const [dmProvider, setDmProvider] = useState('')
  const [dmModel, setDmModel] = useState('')
  const [dmBusy, setDmBusy] = useState(false)

  const remote = props.remote
  const reload = useCallback(async () => {
    if (remote === undefined) return
    if (remote.settings === undefined || remote.session === undefined) {
      setNotice({ failed: true, text: '当前 DSH 版本未提供 settings/session 服务，插件卡片不可用（不影响其他功能）' })
      return
    }
    try {
      const response = await remote.settings.describe()
      if (response?.ok !== true) { setNotice({ failed: true, text: '读取配置失败：' + (response?.error?.message ?? '') }); return }
      const view: NamespaceView | undefined = response.value?.namespaces?.find((row) => row.ns === NS)
      if (view === undefined) { setNotice({ failed: true, text: '命名空间未就绪（插件未启用？）/ namespace not served' }); return }
      setSaved(view.value ?? {})
      setDraft(view.value ?? {})
      setRevision(view.revision)
      setWritable(view.writable !== false)
      setNotice(null)
      const adm = response.value?.namespaces?.find((row) => row.ns === 'agent-default-model')
      setDefaultModel((adm?.value as { provider?: string, model?: string } | undefined) ?? null)
      setAdmRevision(adm?.revision)
      setDmProvider((adm?.value as { provider?: string } | undefined)?.provider ?? '')
      setDmModel((adm?.value as { model?: string } | undefined)?.model ?? '')
      const piAi = response.value?.namespaces?.find((row) => row.ns === PI_AI_NS)
      const providers = (piAi?.value as { providers?: Record<string, RouteProfile> } | undefined)?.providers ?? {}
      setRoutes(providers)
      setPiAiRevision(piAi?.revision)
      const refs = Object.entries(providers)
        .map(([route, profile]) => profile.apiKeyEnv ?? deriveKeyRef(route))
      if (remote.credentials !== undefined && refs.length > 0) {
        try {
          const answer = await remote.credentials.describe(refs)
          if (answer?.ok === true && answer.value !== undefined) {
            const map: Record<string, boolean> = {}
            for (const [ref, v] of Object.entries(answer.value)) map[ref] = v !== undefined && v !== null && v !== ''
            setCredConfigured(map)
          }
        } catch { /* credential status is optional decoration */ }
      }
    } catch (error) { setNotice({ failed: true, text: String(error) }) }
  }, [remote])

  useEffect(() => {
    if (remote === undefined || props.view === 'summary') return
    let alive = true
    void (async () => {
      await reload()
      try {
        const response = await remote.session.modelCatalog()
        if (alive && response?.ok === true) setCatalog(response.value ?? null)
      } catch { /* catalog optional */ }
      try {
        const response = await remote.llm?.listConfigurableProviders()
        if (alive && response?.ok === true) setProviderDir(response.value ?? [])
      } catch { /* directory optional */ }
    })()
    return () => { alive = false }
  }, [remote, props.view, reload])

  const dirty = useMemo(() => saved !== null && draft !== null && !sameConfig(saved, draft), [saved, draft])
  const problems = useMemo(() => draft === null ? [] : invalidReasons(draft), [draft])
  const shell = {
    available: saved !== null,
    writable,
    dirty,
    invalid: problems.length > 0,
    saving: busy,
    failed: notice?.failed === true,
  }

  const catalogById = useMemo(() => new Map((catalog?.groups ?? []).map((g) => [g.id, g])), [catalog])
  const routable = useMemo(() => new Set(catalog?.routableProviders ?? []), [catalog])
  const providerIds = useMemo(() => (catalog?.groups ?? []).map((g) => g.id), [catalog])
  const autoMode = (draft?.groups ?? []).length === 0 && draft?.autoDiscover !== false

  const setDraftConfig = (next: FailoverConfig): void => setDraft(next)
  /** 把目录里的全部 provider（各取第一个模型）生成为可编辑的替补链。 */
  const generateFromCatalog = (): void => {
    const entries = providerIds.map((id) => {
      const model = catalogById.get(id)?.models?.[0]?.id ?? ''
      return { provider: id, model }
    })
    setDraftConfig({ ...draft, groups: [{ id: 'main', entries }] })
  }
  /** 自动模式下的预览链：与宿主实际路由一致 —— llm.listProviders() 的注册顺序。 */
  const autoPreview = useMemo(() => {
    const d = catalog?.default
    return providerIds.map((id) => ({
      provider: id,
      name: catalogById.get(id)?.name ?? id,
      model: d?.provider === id && d?.model !== undefined ? d.model : catalogById.get(id)?.models?.[0]?.id ?? '',
    }))
  }, [providerIds, catalog, catalogById])

  const save = useCallback(async () => {
    if (remote === undefined || draft === null) return
    setBusy(true)
    try {
      const response = await remote.settings.update(NS, draft, revision)
      if (response?.ok !== true) {
        setNotice({ failed: true, text: '保存失败：' + (response?.error?.message ?? '配置已被其他窗口修改，请刷新重试') })
      } else {
        setSaved(draft)
        setNotice({ failed: false, text: '已保存，配置即时生效' })
        void reload()
      }
    } catch (error) {
      setNotice({ failed: true, text: String(error) })
    } finally { setBusy(false) }
  }, [remote, draft, revision, reload])

  /* —— 多账号：识别系统已配置的供应商，一键复制出多把 Key —— */
  const [acctBusy, setAcctBusy] = useState(false)
  const [copyOf, setCopyOf] = useState('')
  const [copyKey, setCopyKey] = useState('')
  const [editOf, setEditOf] = useState('')
  const [editKey, setEditKey] = useState('')

  /** route 是否 baseId 的副本（baseId-2、baseId-3…）。 */
  const isCloneOf = (route: string, baseId: string): boolean =>
    route.startsWith(baseId + '-') && /^\d+$/.test(route.slice(baseId.length + 1))

  /** 复制供应商：只需填新 Key。克隆 profile → 新路由 → 存凭据 → 插入替补链。 */
  const copyProvider = async (baseId: string): Promise<void> => {
    if (remote === undefined || draft === null || routes === null) return
    const base = routes[baseId]
    if (base === undefined || copyKey.trim() === '') return
    let n = 2
    while (routes[baseId + '-' + n] !== undefined) n += 1
    const route = baseId + '-' + n
    setAcctBusy(true)
    try {
      const keyRef = deriveKeyRef(route)
      /* 100% 对齐系统「新增模型」(CustomProviderCard) 的 profile 构成：
         只写 displayName?/apiKeyEnv/api/baseURL/models。
         baseURL 取用户层 ?? 目录 defaultBaseURL；models 取用户层 ?? discoverModels。 */
      const dirEntry = providerDir?.find((row) => row.provider === baseId)
      const baseURL = String(base.baseURL ?? dirEntry?.defaultBaseURL ?? '')
      if (baseURL === '') {
        setNotice({ failed: true, text: '无法确定 ' + baseId + ' 的 baseURL，请先在 设置→模型 为它完成一次配置' })
        return
      }
      let models = base.models ?? []
      if (models.length === 0) {
        const discovered = await remote.llm?.discoverModels(PI_AI_NS, { provider: baseId })
        if (discovered?.ok !== true || (discovered.value ?? []).length === 0) {
          setNotice({ failed: true, text: '获取 ' + baseId + ' 的模型列表失败：' + (discovered?.error?.message ?? '请先在 设置→模型 为它完成一次配置') })
          return
        }
        models = (discovered.value ?? []).map((m) => ({
          id: m.id,
          ...m.name === undefined ? {} : { name: m.name },
          ...m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow },
          ...m.maxTokens === undefined ? {} : { maxTokens: m.maxTokens },
          ...m.inputModalities === undefined ? {} : { input: [...m.inputModalities] },
        }))
      }
      const guessApi = (): string => {
        if (base.api !== undefined) return String(base.api)
        const s = (baseId + ' ' + baseURL).toLowerCase()
        return s.includes('anthropic') || s.includes('claude') ? 'anthropic-messages' : 'openai-completions'
      }
      const profile: RouteProfile = { apiKeyEnv: keyRef, api: guessApi(), baseURL, models: models.map((m) => ({ ...m })) }
      const written = await remote.settings.mutate(PI_AI_NS, [{ op: 'set', path: ['providers', route], value: profile }], piAiRevision)
      if (written?.ok !== true) { setNotice({ failed: true, text: '写入供应商配置失败：' + (written?.error?.message ?? '') }); return }
      if (remote.credentials !== undefined) {
        const stored = await remote.credentials.set(keyRef, copyKey.trim())
        if (stored?.ok !== true) { setNotice({ failed: true, text: '路由已创建，但 Key 存储失败：' + (stored?.error?.message ?? '') }); return }
      }
      // 手动替补链里：紧跟在原账号（及其副本）之后插入新账号；自动模式无需干预
      let next: FailoverConfig = draft
      if ((draft.groups ?? []).length > 0) {
        next = {
          ...draft,
          groups: (draft.groups ?? []).map((g) => {
            const entries = (g.entries ?? []).map((x) => ({ provider: x.provider, model: x.model }))
            let last = -1
            for (let i = 0; i < entries.length; i++) {
              if (entries[i].provider === baseId || isCloneOf(entries[i].provider, baseId)) last = i
            }
            if (last === -1) return { id: g.id, entries }
            entries.splice(last + 1, 0, { provider: route, model: entries[last].model })
            return { id: g.id, entries }
          }),
        }
        const savedChain = await remote.settings.update(NS, next, revision)
        if (savedChain?.ok !== true) setNotice({ failed: true, text: '账号已创建，但插入替补链失败：' + (savedChain?.error?.message ?? '') })
        else { setDraft(next); setSaved(next) }
      }
      if (notice?.failed !== true) setNotice({ failed: false, text: '已复制 ' + baseId + ' → ' + route + '，Key 已加密存储' })
      setCopyOf(''); setCopyKey('')
      void reload()
    } catch (error) {
      setNotice({ failed: true, text: String(error) })
    } finally { setAcctBusy(false) }
  }

  /** 为一条副本路由更换 API Key。 */
  const rekeyRoute = async (route: string): Promise<void> => {
    if (remote === undefined || remote.credentials === undefined || editKey.trim() === '') return
    setAcctBusy(true)
    try {
      const ref = routes?.[route]?.apiKeyEnv ?? deriveKeyRef(route)
      const r = await remote.credentials.set(ref, editKey.trim())
      if (r?.ok === true) { setNotice({ failed: false, text: route + ' 的 Key 已更新' }); setEditOf(''); setEditKey(''); void reload() }
      else setNotice({ failed: true, text: 'Key 写入失败：' + (r?.error?.message ?? '') })
    } catch (error) {
      setNotice({ failed: true, text: String(error) })
    } finally { setAcctBusy(false) }
  }

  const removeAccount = async (route: string): Promise<void> => {
    if (remote === undefined || draft === null || routes === null) return
    if (!window.confirm('删除账号 ' + route + '？将同时移除其配置、凭据与替补链条目。')) return
    setAcctBusy(true)
    try {
      const profile = routes[route]
      const ref = profile?.apiKeyEnv ?? deriveKeyRef(route)
      const removed = await remote.settings.mutate(PI_AI_NS, [{ op: 'unset', path: ['providers', route] }], piAiRevision)
      if (removed?.ok !== true) { setNotice({ failed: true, text: '删除路由失败：' + (removed?.error?.message ?? '') }); return }
      if (remote.credentials !== undefined) { try { await remote.credentials.unset(ref) } catch { /* best effort */ } }
      const next: FailoverConfig = { ...draft, groups: (draft.groups ?? []).map((g) => ({ id: g.id, entries: (g.entries ?? []).filter((x) => x.provider !== route).map((x) => ({ provider: x.provider, model: x.model })) })) }
      const savedChain = await remote.settings.update(NS, next, revision)
      if (savedChain?.ok !== true) setNotice({ failed: true, text: '路由已删除，但更新替补链失败：' + (savedChain?.error?.message ?? '') })
      else { setNotice({ failed: false, text: '账号 ' + route + ' 已删除' }); setDraft(next); setSaved(next) }
      void reload()
    } catch (error) {
      setNotice({ failed: true, text: String(error) })
    } finally { setAcctBusy(false) }
  }

  /** 切换默认模型（与官方 设置→模型 同一命名空间与写入方式）。 */
  const saveDefaultModel = async (): Promise<void> => {
    if (remote === undefined || dmProvider === '' || dmModel === '') return
    setDmBusy(true)
    try {
      const w = await remote.settings.mutate('agent-default-model', [
        { op: 'set', path: ['provider'], value: dmProvider },
        { op: 'set', path: ['model'], value: dmModel },
      ], admRevision)
      if (w?.ok !== true) { setNotice({ failed: true, text: '切换默认模型失败：' + (w?.error?.message ?? '') }); return }
      setNotice({ failed: false, text: '默认模型已切换为 ' + dmProvider + ' / ' + dmModel })
      void reload()
    } catch (error) {
      setNotice({ failed: true, text: String(error) })
    } finally { setDmBusy(false) }
  }

  if (props.view === 'summary') {
    return `多供应商 / 多账号模型自动替补：额度用完自动按替补顺序切换下一棒，任务不中断（Model & account failover）· v${VERSION}`
  }
  if (saved === null || draft === null) {
    return <p style={hint}>{notice?.text ?? '加载中… / loading…'}</p>
  }

  const groups = draft.groups ?? []
  const activeId = draft.activeGroup || groups[0]?.id || ''

  const patchGroup = (index: number, patch: Partial<Group>): void => {
    if (draft === null) return
    setDraftConfig({ ...draft, groups: (draft.groups ?? []).map((g, i) => i === index ? { ...g, ...patch } : g) })
  }
  const moveEntry = (gi: number, ei: number, delta: number): void => {
    const group = groups[gi]
    const entries = [...(group?.entries ?? [])]
    const target = ei + delta
    if (group === undefined || target < 0 || target >= entries.length) return
    ;[entries[ei], entries[target]] = [entries[target], entries[ei]]
    patchGroup(gi, { entries })
  }
  const duplicateEntry = (gi: number, ei: number): void => {
    const group = groups[gi]
    const entries = [...(group?.entries ?? [])]
    if (group === undefined) return
    const source = entries[ei]
    if (source === undefined) return
    let n = 2
    const base = source.provider.replace(/-\d+$/, '')
    while (entries.some((e) => e.provider === base + '-' + n)) n += 1
    entries.splice(ei + 1, 0, { provider: base + '-' + n, model: source.model })
    patchGroup(gi, { entries })
  }

  const modelOptions = (provider: string): CatalogModel[] => catalogById.get(provider)?.models ?? []
  const entryRow = (group: Group, gi: number) => (entry: Entry, ei: number): ReactNode => {
    const options = modelOptions(entry.provider)
    const routableEntry = routable.has(entry.provider) || !catalogById.has(entry.provider)
    return (
      <li key={ei} style={{ ...row, padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.12))' }}>
        <span style={{ opacity: 0.5, fontSize: 12, width: 26, textAlign: 'right' }}>{ei + 1}</span>
        <span style={providerCell} title={'可路由 routable: ' + String(routableEntry)}>
          <span style={dot(routableEntry)} />
          <Input value={entry.provider} placeholder="provider（账号）" list={'mf-provs-' + gi + '-' + ei}
            style={{ width: 200 }} onChange={(e) => patchGroup(gi, { entries: (group.entries ?? []).map((x, i) => i === ei ? { ...x, provider: e.target.value } : x) })} />
        </span>
        <datalist id={'mf-provs-' + gi + '-' + ei}>
          {providerIds.map((id) => <option key={id} value={id} />)}
        </datalist>
        {options.length > 0
          ? (
            <select value={entry.model} style={selectStyle}
              onChange={(e) => patchGroup(gi, { entries: (group.entries ?? []).map((x, i) => i === ei ? { ...x, model: e.target.value } : x) })}>
              {!options.some((m) => m.id === entry.model) ? <option value={entry.model}>{entry.model}</option> : null}
              {options.map((m) => <option key={m.id} value={m.id}>{m.name !== undefined && m.name !== m.id ? m.name + ' · ' + m.id : m.id}</option>)}
            </select>
            )
          : (
            <Input value={entry.model} placeholder="model" style={{ width: 180 }}
              onChange={(e) => patchGroup(gi, { entries: (group.entries ?? []).map((x, i) => i === ei ? { ...x, model: e.target.value } : x) })} />
            )}
        <span style={{ flex: 1 }} />
        <Button variant="ghost" disabled={ei === 0} onClick={() => moveEntry(gi, ei, -1)} title="上移（优先级更高）">↑</Button>
        <Button variant="ghost" disabled={ei === (group.entries?.length ?? 1) - 1} onClick={() => moveEntry(gi, ei, 1)} title="下移">↓</Button>
        <Button variant="ghost" onClick={() => duplicateEntry(gi, ei)} title="复制为此账号的替补（多 Key 多账号）">复制账号</Button>
        <Button variant="ghost" onClick={() => patchGroup(gi, { entries: (group.entries ?? []).filter((_, i) => i !== ei) })} title="删除">✕</Button>
      </li>
    )
  }

  return (
    <SettingsForm
      labels={{
        unavailable: '命名空间未就绪（插件未启用）/ namespace not served',
        readOnly: '当前部署的配置为只读 / read-only',
        saveFailed: notice?.failed === true ? (notice.text) : '',
        save: '保存 / Save',
        saving: '保存中…',
      }}
      state={shell}
      onSave={() => { void save() }}
      onDiscard={() => { if (saved !== null) { setDraft(saved); setNotice(null) } }}
    >
      <div style={{ display: 'grid', gap: 18 }}>
        {/* —— 切换通知（Host 写入 lastSwitches，卡片展示）—— */}
        {(saved.lastSwitches ?? []).length > 0 ? (
          <section style={{ ...card, borderColor: 'var(--dsw-alias-state-warn-stroke, rgba(200,140,40,0.4))' }}>
            <div style={row}>
              <span title="切换提示">🔁</span>
              <strong style={{ fontSize: 13 }}>最近切换</strong>
              <span style={{ flex: 1 }} />
            </div>
            <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'grid', gap: 4 }}>
              {(saved.lastSwitches ?? []).slice(-3).reverse().map((s, i) => (
                <li key={i} style={{ ...row, fontSize: 12 }}>
                  <span style={{ opacity: 0.75 }}>{s.from}</span>
                  <span>→</span>
                  <strong style={{ color: 'var(--dsw-alias-state-warn-label, #b8860b)' }}>{s.to}</strong>
                  <span style={{ opacity: 0.55 }}>（{s.reason}{s.via === 'fallback' ? ' · 目录兜底' : s.via === 'second-chance' ? ' · 充值探测' : ''}）</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ opacity: 0.5 }}>{new Date(s.at).toLocaleString('zh-CN', { hour12: false })}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* —— 模型（当前默认，可切换）—— */}
        <section style={surface}>
          <h3 style={sectionTitle}>模型</h3>
          <div style={card}>
            <div style={row}>
              <span style={dot(defaultModel?.provider !== undefined && defaultModel.provider !== '')} />
              <select value={dmProvider} style={selectStyle}
                onChange={(e) => { setDmProvider(e.target.value); setDmModel(catalogById.get(e.target.value)?.models?.[0]?.id ?? '') }}>
                {providerIds.map((id) => <option key={id} value={id}>{catalogById.get(id)?.name ?? id}</option>)}
              </select>
              <select value={dmModel} style={selectStyle} onChange={(e) => setDmModel(e.target.value)}>
                {(catalogById.get(dmProvider)?.models ?? []).map((m) => <option key={m.id} value={m.id}>{m.name !== undefined && m.name !== m.id ? m.name + ' · ' + m.id : m.id}</option>)}
              </select>
              <span style={{ flex: 1 }} />
              <Button variant="outline" disabled={dmBusy || dmProvider === '' || dmModel === '' || (dmProvider === defaultModel?.provider && dmModel === defaultModel?.model)}
                onClick={() => void saveDefaultModel()}>切换</Button>
            </div>
            <p style={hint}>当前默认模型，可在此直接切换。任一账号失败/额度用尽时，毫秒级立即切换到顺序中的下一个健康账号，任务不中断；故障账号冷却 {draft.cooldownMinutes ?? 30} 分钟后自动归队。</p>
          </div>
        </section>

        {/* —— 切换顺序：自动 —— */}
        {autoMode ? (
          <section style={surface}>
            <div style={row}>
              <span style={dot(true)} />
              <h3 style={{ ...sectionTitle, margin: 0 }}>切换顺序 · 自动替补（默认）</h3>
            </div>
            <p style={hint}>
              当前已配置 {autoPreview.length} 个 provider，按注册顺序互相替补，
              任一账号额度用尽自动切到下一个。下方为实时预览：
            </p>
            <ol style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              {autoPreview.map((rowItem, i) => (
                <li key={rowItem.provider} style={{ ...row, padding: '3px 0' }}>
                  <span style={{ opacity: 0.5, fontSize: 12, width: 22, textAlign: 'right' }}>{i + 1}</span>
                  <span style={providerCell}>
                    <span style={dot(routable.has(rowItem.provider))} />
                    <strong style={{ fontWeight: 600 }}>{rowItem.name}</strong>
                    <span style={{ opacity: 0.5, fontSize: 12 }}>{rowItem.provider}</span>
                  </span>
                  <span style={{ opacity: 0.7, fontSize: 12 }}>{rowItem.model}</span>
                </li>
              ))}
            </ol>
            {catalog === null ? <p style={hint}>模型目录加载中（或不可用），自动链将在目录就绪后生效。</p> : null}
            <p style={hint}>要自定义顺序或账号，点击下方"转为手动配置"；清空全部分组即可回到自动模式。</p>
          </section>
        ) : null}

        {/* —— 手动分组 —— */}
        {autoMode ? (
          <Button variant="outline" onClick={generateFromCatalog}>转为手动配置（从已配置模型生成替补链）</Button>
        ) : (
          <section style={surface}>
            <div style={row}>
              <h3 style={{ ...sectionTitle, margin: 0 }}>切换顺序 · 手动替补链</h3>
              <span style={{ flex: 1 }} />
              <Button variant="ghost" onClick={() => setDraftConfig({ ...draft, groups: [] })}>清空，回到自动模式</Button>
            </div>
            {groups.map((group, gi) => (
              <div key={gi} style={{ ...card, marginBottom: 10, opacity: autoMode ? 1 : (group.id === draft.activeGroup || groups.length === 1 ? 1 : 0.75) }}>
                <div style={row}>
                  <Input value={group.id} placeholder="group id" style={{ width: 160 }}
                    onChange={(e) => patchGroup(gi, { id: e.target.value })} />
                  <Checkbox checked={group.id === draft.activeGroup} label="激活 active"
                    onChange={() => setDraftConfig({ ...draft, activeGroup: group.id })} />
                  <span style={{ flex: 1 }} />
                  <Button variant="ghost" onClick={() => setDraftConfig({ ...draft, groups: groups.filter((_, i) => i !== gi) })}>删除组</Button>
                </div>
                <div style={{ marginTop: 8 }}>
                  {(group.entries ?? []).map(entryRow(group, gi))}
                </div>
                <div style={{ ...row, marginTop: 8 }}>
                  <select defaultValue="" style={selectStyle}
                    onChange={(e) => {
                      const provider = e.target.value
                      if (provider === '') return
                      const model = catalogById.get(provider)?.models?.[0]?.id ?? ''
                      patchGroup(gi, { entries: [...(group.entries ?? []), { provider, model }] })
                      e.target.value = ''
                    }}>
                    <option value="" disabled>＋ 从已配置的模型添加…</option>
                    {providerIds.map((id) => <option key={id} value={id}>{catalogById.get(id)?.name ?? id}</option>)}
                  </select>
                  <Button variant="ghost" onClick={() => patchGroup(gi, { entries: [...(group.entries ?? []), { provider: '', model: '' }] })}>＋ 手动添加</Button>
                </div>
                <p style={hint}>多 Key：复制账号（或 Models 页新建同名自定义 provider）后各配一个 Key，插件按顺序自动切换。</p>
              </div>
            ))}
            <Button variant="outline" onClick={() => setDraftConfig({ ...draft, groups: [...groups, { id: 'group-' + (groups.length + 1), entries: [] }] })}>
              ＋ 添加分组 add group
            </Button>
          </section>
        )}

        {/* —— 多账号：同一供应商多把 Key —— */}
        <section style={surface}>
          <h3 style={sectionTitle}>账号（多 Key）</h3>
          <p style={hint}>自动识别系统已配置的供应商。点「复制」只需填一把新 Key，即可为同一供应商加一个账号（如 GLM × 3）；额度用尽自动切到下一个，其余配置零重复。</p>
          {catalog === null || routes === null ? <p style={hint}>正在读取系统模型配置…</p> : (
            <ul style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, display: 'grid', gap: 8 }}>
              {providerIds.filter((id) => !providerIds.some((other) => other !== id && isCloneOf(id, other))).map((baseId) => {
                const info = catalogById.get(baseId)
                const baseProfile = routes[baseId]
                const clones = Object.keys(routes).filter((r) => isCloneOf(r, baseId)).sort()
                const ref = baseProfile?.apiKeyEnv ?? deriveKeyRef(baseId)
                const copying = copyOf === baseId
                return (
                  <li key={baseId} style={card}>
                    <div style={row}>
                      <span style={dot(credConfigured[ref] === true)} title={credConfigured[ref] === true ? 'Key 已配置' : 'Key 未配置'} />
                      <strong>{info?.name ?? baseId}</strong>
                      <span style={{ opacity: 0.5, fontSize: 12 }}>{baseId}</span>
                      {clones.length > 0 ? <span style={{ opacity: 0.6, fontSize: 12 }}>已加 {clones.length} 个账号</span> : null}
                      <span style={{ flex: 1 }} />
                      {copying ? (
                        <>
                          <Input type="password" placeholder="新账号的 API Key" style={{ width: 240 }} value={copyKey} onChange={(e) => setCopyKey(e.target.value)} />
                          <Button variant="outline" disabled={acctBusy || copyKey.trim() === ''} onClick={() => void copyProvider(baseId)}>保存</Button>
                          <Button variant="ghost" onClick={() => { setCopyOf(''); setCopyKey('') }}>取消</Button>
                        </>
                      ) : (
                        <Button variant="ghost" disabled={baseProfile === undefined || acctBusy} title={baseProfile === undefined ? '该供应商尚未配置，请先在 设置→模型 完成一次配置' : '复制此供应商，为新账号填一把新 Key'} onClick={() => { setCopyOf(baseId); setCopyKey('') }}>复制</Button>
                      )}
                    </div>
                    {clones.length > 0 ? (
                      <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'grid', gap: 4 }}>
                        {clones.map((route) => {
                          const cref = routes[route]?.apiKeyEnv ?? deriveKeyRef(route)
                          const cok = credConfigured[cref] === true
                          const editing = editOf === route
                          return (
                            <li key={route} style={{ ...row, paddingLeft: 4 }}>
                              <span style={dot(cok)} title={cok ? 'Key 已配置' : 'Key 未配置'} />
                              <span style={{ fontSize: 13, minWidth: 110 }}>{route}</span>
                              {(() => {
                                const opts = (routes[route]?.models ?? []).map((m) => m.id)
                                let chained
                                for (const g of draft.groups ?? []) {
                                  const hit = (g.entries ?? []).find((x) => x.provider === route)
                                  if (hit !== undefined) { chained = hit.model; break }
                                }
                                const current = chained ?? opts[0] ?? ''
                                const options = opts.includes(current) ? opts : [current, ...opts]
                                return (
                                  <select value={current} title={chained === undefined ? '该账号不在替补链中' : '此账号在替补链中使用的模型（修改后需保存）'}
                                    style={{ ...selectStyle, fontSize: 12, flex: 1, maxWidth: 200 }}
                                    onChange={(e) => {
                                      const model = e.target.value
                                      const groups = (draft.groups ?? []).map((g) => ({
                                        id: g.id,
                                        entries: (g.entries ?? []).map((x) => x.provider === route ? { provider: x.provider, model } : x),
                                      }))
                                      const touched = groups.some((g) => (g.entries ?? []).some((x) => x.provider === route))
                                      if (!touched) { setNotice({ failed: true, text: route + ' 不在替补链中，请先复制或手动加入' }); return }
                                      setDraftConfig({ ...draft, groups })
                                    }}>
                                    {options.map((id) => <option key={id} value={id}>{id}</option>)}
                                  </select>
                                )
                              })()}
                              {editing ? (
                                <>
                                  <Input type="password" placeholder="新的 API Key" style={{ width: 200 }} value={editKey} onChange={(e) => setEditKey(e.target.value)} />
                                  <Button variant="outline" disabled={acctBusy || editKey.trim() === ''} onClick={() => void rekeyRoute(route)}>保存</Button>
                                  <Button variant="ghost" onClick={() => { setEditOf(''); setEditKey('') }}>取消</Button>
                                </>
                              ) : (
                                <>
                                  <Button variant="ghost" disabled={!cok || remote.credentials === undefined} onClick={() => { setEditOf(route); setEditKey('') }}>换 Key</Button>
                                  <Button variant="ghost" disabled={acctBusy} onClick={() => void removeAccount(route)}>删除</Button>
                                </>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        {/* 高级策略（冷却/触发类别）保留为配置项，默认值即可，不再暴露 UI */}

        {problems.length > 0 ? <p style={{ ...hint, color: 'var(--dsw-alias-text-danger, #c33)' }}>⚠ {problems.join('；')}</p> : null}
        {notice !== null && !notice.failed ? <p style={hint}>{notice.text}</p> : null}
      </div>
    </SettingsForm>
  )
}

/** Browser plugin body. */
export const inject = ['slots', 'remote', 'remote.settings', 'remote.session', 'remote.llm', 'remote.credentials']

export function apply(ctx: { slots: SlotsFace, remote: RemoteFace, effect?: (factory: () => () => void, label?: string) => void }): void {
  const register = (): (() => void) => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item',
    id: 'model-failover',
    order: 40,
    label: () => 'Model Failover 模型替补',
  }, (props: { view?: string }) => <FailoverCard {...props} remote={ctx.remote} />))
  if (ctx.effect !== undefined) ctx.effect(register, 'model-failover: plugins card')
  else register()
}

interface SlotsFace {
  inject(key: string, factory: () => () => void): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}
