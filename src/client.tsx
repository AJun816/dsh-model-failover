/**
 * dsh-model-failover — browser half.
 *
 * A Plugins-page card (the `plugins.item` slot declared by
 * ui-plugin-manager) that edits this plugin's `model-failover` settings
 * namespace over the public `remote.settings` wire, styled with the shared
 * ui-primitives so it matches the stock settings pages. The model catalog
 * (`remote.session.modelCatalog`) feeds a picker of already-configured
 * providers/models, so accounts rarely need typing.
 *
 * @module dsh-model-failover/client
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { SettingsForm } from '@deepseek-ai/dsh-client-ui-primitives'

/** One fallback hop as stored in config. */
interface Entry { provider: string, model: string }
interface Group { id: string, entries: Entry[] }
interface FailoverConfig {
  groups?: Group[]
  activeGroup?: string
  cooldownMinutes?: number
  retryOn?: string[]
}
interface NamespaceView { ns: string, value?: FailoverConfig, revision?: number, writable?: boolean }
interface CatalogModel { id: string, name?: string }
interface CatalogGroup { id: string, name?: string, models?: CatalogModel[] }
interface ModelCatalog { default?: { provider?: string, model?: string }, groups?: CatalogGroup[] }

const NS = 'model-failover'
const RETRY_CLASSES = ['quota', 'rate-limit', 'auth', 'network']
const RETRY_HINT: Record<string, string> = {
  quota: '额度用尽（402 / 余额不足）',
  'rate-limit': '限流（429）',
  auth: '鉴权失效（401/403）',
  network: '网络 / 供应商宕机（5xx）',
}

const row: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }
const sectionTitle: CSSProperties = { margin: '2px 0 8px', fontSize: 13, fontWeight: 600, opacity: 0.85 }
const hint: CSSProperties = { opacity: 0.6, fontSize: 12, margin: '4px 0 0' }
const card: CSSProperties = { border: '1px solid var(--dsw-alias-border-subtle, #8884)', borderRadius: 10, padding: 12, marginBottom: 10 }

/** The remote faces this card consumes (structural subsets of ctx.remote). */
interface RemoteFace {
  settings: {
    describe(): Promise<{ ok: boolean, value?: { namespaces?: NamespaceView[] }, error?: { message?: string } }>
    update(ns: string, value: FailoverConfig, revision?: number): Promise<{ ok: boolean, value?: unknown, error?: { message?: string } }>
  }
  session: {
    modelCatalog(): Promise<{ ok: boolean, value?: ModelCatalog, error?: { message?: string } }>
  }
}

function sameConfig(a: FailoverConfig, b: FailoverConfig): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))
}
function normalize(c: FailoverConfig): FailoverConfig {
  return {
    groups: (c.groups ?? []).map((g) => ({ id: g.id, entries: (g.entries ?? []).map((e) => ({ provider: e.provider, model: e.model })) })),
    activeGroup: c.activeGroup ?? '',
    cooldownMinutes: c.cooldownMinutes ?? 30,
    retryOn: [...(c.retryOn ?? [])].sort(),
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

  const remote = props.remote
  const reload = useCallback(async () => {
    if (remote === undefined) return
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
      } catch { /* catalog optional; the picker just stays hidden */ }
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
  const providerIds = useMemo(() => (catalog?.groups ?? []).map((g) => g.id), [catalog])
  const activeId = draft?.activeGroup || draft?.groups?.[0]?.id || ''

  const setDraftConfig = (next: FailoverConfig): void => setDraft(next)
  const patchGroup = (index: number, patch: Partial<Group>): void => {
    if (draft === null) return
    setDraftConfig({ ...draft, groups: (draft.groups ?? []).map((g, i) => i === index ? { ...g, ...patch } : g) })
  }
  const moveEntry = (gi: number, ei: number, delta: number): void => {
    const group = draft?.groups?.[gi]
    const entries = [...(group?.entries ?? [])]
    const target = ei + delta
    if (group === undefined || target < 0 || target >= entries.length) return
    ;[entries[ei], entries[target]] = [entries[target], entries[ei]]
    patchGroup(gi, { entries })
  }
  const duplicateEntry = (gi: number, ei: number): void => {
    const group = draft?.groups?.[gi]
    const entries = [...(group?.entries ?? [])]
    if (group === undefined) return
    const source = entries[ei]
    if (source === undefined) return
    // Multi-account: copy the route; point it at a sibling provider entry the
    // user creates for the second key (Models page → 添加自定义 provider).
    let n = 2
    const base = source.provider.replace(/-\d+$/, '')
    while (entries.some((e) => e.provider === base + '-' + n)) n += 1
    entries.splice(ei + 1, 0, { provider: base + '-' + n, model: source.model })
    patchGroup(gi, { entries })
  }

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

  if (props.view === 'summary') {
    return '多供应商 / 多账号模型自动替补：额度用完自动按替补顺序切换下一棒，任务不中断（Model & account failover）'
  }
  if (saved === null || draft === null) {
    return <p style={hint}>{notice?.text ?? '加载中… / loading…'}</p>
  }

  const catalogPicker = (gi: number): ReactNode => {
    if (providerIds.length === 0) return null
    return (
      <div style={{ ...row, marginTop: 6 }}>
        <select
          defaultValue=""
          style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-subtle, #8884)', background: 'transparent', color: 'inherit' }}
          onChange={(e) => {
            const provider = e.target.value
            if (provider === '') return
            const group = catalogById.get(provider)
            const model = group?.models?.[0]?.id ?? ''
            patchGroup(gi, { entries: [...(draft?.groups?.[gi]?.entries ?? []), { provider, model }] })
            e.target.value = ''
          }}>
          <option value="" disabled>＋ 从已配置的模型添加…</option>
          {providerIds.map((id) => <option key={id} value={id}>{catalogById.get(id)?.name ?? id}</option>)}
        </select>
        <span style={hint}>选择后自动填入该 provider 的第一个模型，可再修改</span>
      </div>
    )
  }

  const modelOptions = (provider: string): CatalogModel[] => catalogById.get(provider)?.models ?? []

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
      <div style={{ display: 'grid', gap: 14 }}>
        <section>
          <h3 style={sectionTitle}>替补链 Fallback groups —— 数组顺序即替补顺序</h3>
          {(draft.groups ?? []).length === 0 ? <p style={hint}>尚未配置分组。No groups yet.</p> : null}
          {(draft.groups ?? []).map((group, gi) => (
            <div key={gi} style={{ ...card, opacity: group.id === activeId ? 1 : 0.6 }}>
              <div style={row}>
                <Input value={group.id} placeholder="group id" style={{ width: 160 }}
                  onChange={(e) => patchGroup(gi, { id: e.target.value })} />
                <Checkbox checked={group.id === activeId} label="激活 active"
                  onChange={() => setDraftConfig({ ...draft, activeGroup: group.id })} />
                <Button variant="ghost" onClick={() => setDraftConfig({ ...draft, groups: (draft.groups ?? []).filter((_, i) => i !== gi) })}>删除组</Button>
              </div>
              <ol style={{ margin: '8px 0 0', paddingLeft: 18, display: 'grid', gap: 6 }}>
                {(group.entries ?? []).map((entry, ei) => {
                  const options = modelOptions(entry.provider)
                  return (
                    <li key={ei} style={row}>
                      <span style={{ opacity: 0.55, fontSize: 12, width: 22 }}>#{ei + 1}</span>
                      <Input value={entry.provider} placeholder="provider（账号）" list={'mf-provs-' + gi + '-' + ei}
                        style={{ width: 190 }}
                        onChange={(e) => patchGroup(gi, { entries: (group.entries ?? []).map((x, i) => i === ei ? { ...x, provider: e.target.value } : x) })} />
                      <datalist id={'mf-provs-' + gi + '-' + ei}>
                        {providerIds.map((id) => <option key={id} value={id} />)}
                      </datalist>
                      {options.length > 0
                        ? (
                          <select value={entry.model} style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-subtle, #8884)', background: 'transparent', color: 'inherit' }}
                            onChange={(e) => patchGroup(gi, { entries: (group.entries ?? []).map((x, i) => i === ei ? { ...x, model: e.target.value } : x) })}>
                            {!options.some((m) => m.id === entry.model) ? <option value={entry.model}>{entry.model}</option> : null}
                            {options.map((m) => <option key={m.id} value={m.id}>{m.name !== undefined && m.name !== m.id ? m.name + '（' + m.id + '）' : m.id}</option>)}
                          </select>
                          )
                        : (
                          <Input value={entry.model} placeholder="model" style={{ width: 170 }}
                            onChange={(e) => patchGroup(gi, { entries: (group.entries ?? []).map((x, i) => i === ei ? { ...x, model: e.target.value } : x) })} />
                          )}
                      <Button variant="ghost" disabled={ei === 0} onClick={() => moveEntry(gi, ei, -1)} title="上移">↑</Button>
                      <Button variant="ghost" disabled={ei === (group.entries?.length ?? 1) - 1} onClick={() => moveEntry(gi, ei, 1)} title="下移">↓</Button>
                      <Button variant="ghost" onClick={() => duplicateEntry(gi, ei)} title="复制为此账号的替补（多 Key 多账号）">复制账号</Button>
                      <Button variant="ghost" onClick={() => patchGroup(gi, { entries: (group.entries ?? []).filter((_, i) => i !== ei) })} title="删除">✕</Button>
                    </li>
                  )
                })}
              </ol>
              {catalogPicker(gi)}
              <p style={hint}>多账号：在 设置 → Models 为同一供应商添加多个自定义 provider（各配一个 Key），或点"复制账号"复制条目后修改 provider 名。</p>
            </div>
          ))}
          <Button variant="outline" onClick={() => setDraftConfig({ ...draft, groups: [...(draft.groups ?? []), { id: 'group-' + ((draft.groups?.length ?? 0) + 1), entries: [{ provider: draft?.groups?.[0]?.entries?.[0]?.provider ?? '', model: '' }] }] })}>
            ＋ 添加分组 add group
          </Button>
        </section>

        <section style={row}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={sectionTitle}>冷却（分钟）cooldown</span>
            <Input type="number" min={1} value={draft.cooldownMinutes ?? 30} style={{ width: 120 }}
              onChange={(e) => setDraftConfig({ ...draft, cooldownMinutes: Number(e.target.value) || 30 })} />
          </label>
          <div style={{ display: 'grid', gap: 4 }}>
            <span style={sectionTitle}>触发切换的错误类别 retry on</span>
            <div style={row}>
              {RETRY_CLASSES.map((klass) => (
                <Checkbox key={klass} checked={(draft.retryOn ?? RETRY_CLASSES).includes(klass)} label={klass}
                  title={RETRY_HINT[klass]}
                  onChange={(next) => {
                    const current = new Set(draft.retryOn ?? RETRY_CLASSES)
                    if (next) current.add(klass)
                    else current.delete(klass)
                    setDraftConfig({ ...draft, retryOn: [...current] })
                  }} />
              ))}
            </div>
          </div>
        </section>

        {problems.length > 0 ? <p style={{ ...hint, color: 'var(--dsw-alias-text-danger, #c33)' }}>⚠ {problems.join('；')}</p> : null}
        {notice !== null && !notice.failed ? <p style={hint}>{notice.text}</p> : null}
      </div>
    </SettingsForm>
  )
}

/** Browser plugin body. */
export const inject = ['slots', 'remote', 'remote.settings', 'remote.session']

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
