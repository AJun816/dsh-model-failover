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
import type { CSSProperties, ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { SettingsForm } from '@deepseek-ai/dsh-client-ui-primitives'

interface Entry { provider: string, model: string }
interface Group { id: string, entries: Entry[] }
interface FailoverConfig {
  groups?: Group[]
  activeGroup?: string
  cooldownMinutes?: number
  retryOn?: string[]
  autoDiscover?: boolean
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
    autoDiscover: c.autoDiscover ?? true,
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
      } catch { /* catalog optional */ }
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
  /** 自动模式下的预览链：目录顺序，default 路由优先。 */
  const autoPreview = useMemo(() => {
    const ids = providerIds
    const d = catalog?.default
    const ordered = d?.provider !== undefined && ids.includes(d.provider)
      ? [d.provider, ...ids.filter((id) => id !== d.provider)]
      : ids
    return ordered.map((id) => ({
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

  if (props.view === 'summary') {
    return '多供应商 / 多账号模型自动替补：额度用完自动按替补顺序切换下一棒，任务不中断（Model & account failover）'
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
        {/* —— 自动模式 —— */}
        {autoMode ? (
          <section style={surface}>
            <div style={row}>
              <span style={dot(true)} />
              <h3 style={{ ...sectionTitle, margin: 0 }}>自动替补已启用（默认）</h3>
            </div>
            <p style={hint}>
              当前已配置 {autoPreview.length} 个 provider，按注册顺序互相替补（默认模型优先），
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
              <h3 style={{ ...sectionTitle, margin: 0 }}>手动替补链</h3>
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

        {/* —— 切换策略 —— */}
        <section style={surface}>
          <h3 style={sectionTitle}>切换策略</h3>
          <div style={row}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ ...mutedTitle }}>冷却（分钟）cooldown</span>
              <Input type="number" min={1} value={draft.cooldownMinutes ?? 30} style={{ width: 130 }}
                onChange={(e) => setDraftConfig({ ...draft, cooldownMinutes: Number(e.target.value) || 30 })} />
            </label>
            <div style={{ display: 'grid', gap: 4 }}>
              <span style={mutedTitle}>触发切换的错误类别 retry on</span>
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
