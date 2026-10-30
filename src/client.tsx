/**
 * dsh-model-failover — browser half.
 *
 * Registers a card on the Plugins settings page (the `plugins.item` slot
 * declared by ui-plugin-manager) that edits this plugin's `model-failover`
 * settings namespace over the public `remote.settings` wire: fallback
 * groups, ordered entries, cooldown, and retry classes. No custom Host API —
 * the same generic settings RPC every settings page uses.
 *
 * @module dsh-model-failover/client
 */

import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

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

const NS = 'model-failover'
const RETRY_CLASSES = ['quota', 'rate-limit', 'auth', 'network']

const label = { margin: '4px 0', fontWeight: 600 }
const input: CSSProperties = {
  padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsh-border, #555)',
  background: 'var(--dsh-input-bg, transparent)', color: 'inherit', minWidth: 120,
}
const button: CSSProperties = { padding: '4px 10px', borderRadius: 6, cursor: 'pointer' }
const muted = { opacity: 0.7, fontSize: 12 }

function FailoverCard(props: { view?: string, remote?: RemoteFace, open?: boolean }): ReactNode {
  const [config, setConfig] = useState<FailoverConfig | null>(null)
  const [revision, setRevision] = useState<number | undefined>(undefined)
  const [writable, setWritable] = useState(true)
  const [status, setStatus] = useState<string>('')
  const [busy, setBusy] = useState(false)

  const remote = props.remote
  useEffect(() => {
    if (remote === undefined || props.view === 'summary') return
    let alive = true
    void (async () => {
      try {
        const response = await remote.settings.describe()
        if (!alive) return
        if (response?.ok !== true) { setStatus('读取配置失败 / failed to read settings'); return }
        const view: NamespaceView | undefined = response.value?.namespaces?.find((row: NamespaceView) => row.ns === NS)
        if (view === undefined) { setStatus('命名空间未就绪（插件可能未启用）/ namespace not served'); return }
        setConfig(view.value ?? {})
        setRevision(view.revision)
        setWritable(view.writable !== false)
      } catch (error) {
        if (alive) setStatus(String(error))
      }
    })()
    return () => { alive = false }
  }, [remote, props.view])

  const mutate = useCallback((next: FailoverConfig) => {
    setConfig(next)
  }, [])

  const save = useCallback(async () => {
    if (remote === undefined || config === null) return
    setBusy(true)
    setStatus('')
    try {
      const response = await remote.settings.update(NS, config, revision)
      if (response?.ok !== true) {
        setStatus('保存失败：' + (response?.error?.message ?? 'unknown') + '（配置可能已被其他窗口修改，请刷新页面重试）')
      } else {
        const view: NamespaceView | undefined = response.value?.namespaces?.find((row: NamespaceView) => row.ns === NS)
        setRevision(view?.revision ?? revision)
        setConfig(view?.value ?? config)
        setStatus('已保存 / saved — 配置即时生效，无需重启')
      }
    } catch (error) {
      setStatus(String(error))
    } finally {
      setBusy(false)
    }
  }, [remote, config, revision])

  if (props.view === 'summary') {
    return '多供应商 / 多账号模型自动替补：额度用完自动切换下一棒（Model & account failover）'
  }
  if (config === null) {
    return <div style={muted}>{status || '加载中… / loading…'}</div>
  }

  const groups = config.groups ?? []
  const active = config.activeGroup || groups[0]?.id || ''

  const patchGroup = (index: number, patch: Partial<Group>): void => {
    const next = groups.map((group, i) => i === index ? { ...group, ...patch } : group)
    mutate({ ...config, groups: next })
  }
  const moveEntry = (groupIndex: number, entryIndex: number, delta: number): void => {
    const entries = [...(groups[groupIndex]?.entries ?? [])]
    const target = entryIndex + delta
    if (target < 0 || target >= entries.length) return
    ;[entries[entryIndex], entries[target]] = [entries[target], entries[entryIndex]]
    patchGroup(groupIndex, { entries })
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <section>
        <h3 style={label}>替补链 Fallback groups</h3>
        {groups.length === 0 ? <p style={muted}>尚未配置分组。No groups yet.</p> : null}
        {groups.map((group, gi) => (
          <div key={group.id || gi} style={{ border: '1px solid var(--dsh-border,#444)', borderRadius: 8, padding: 10, marginBottom: 10, opacity: group.id === active ? 1 : 0.65 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input style={input} value={group.id} placeholder="group id"
                onChange={(e) => patchGroup(gi, { id: e.target.value })} />
              <label style={muted}>
                <input type="radio" name="mf-active" checked={group.id === active}
                  onChange={() => mutate({ ...config, activeGroup: group.id })} /> 激活 active
              </label>
              <button style={button} onClick={() => mutate({ ...config, groups: groups.filter((_, i) => i !== gi) })}>删除组</button>
            </div>
            <ol style={{ margin: '8px 0 0', paddingLeft: 20 }}>
              {(group.entries ?? []).map((entry, ei) => (
                <li key={ei} style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '4px 0', flexWrap: 'wrap' }}>
                  <span style={{ ...muted, opacity: 1 }}>#{ei + 1}</span>
                  <input style={input} value={entry.provider} placeholder="provider（如 glm-1）"
                    onChange={(e) => patchGroup(gi, { entries: (group.entries ?? []).map((x, i) => i === ei ? { ...x, provider: e.target.value } : x) })} />
                  <input style={input} value={entry.model} placeholder="model（如 glm-4.7）"
                    onChange={(e) => patchGroup(gi, { entries: (group.entries ?? []).map((x, i) => i === ei ? { ...x, model: e.target.value } : x) })} />
                  <button style={button} onClick={() => moveEntry(gi, ei, -1)} disabled={ei === 0}>↑</button>
                  <button style={button} onClick={() => moveEntry(gi, ei, 1)} disabled={ei === (group.entries?.length ?? 1) - 1}>↓</button>
                  <button style={button} onClick={() => patchGroup(gi, { entries: (group.entries ?? []).filter((_, i) => i !== ei) })}>✕</button>
                </li>
              ))}
            </ol>
            <button style={{ ...button, marginTop: 6 }}
              onClick={() => patchGroup(gi, { entries: [...(group.entries ?? []), { provider: '', model: '' }] })}>
              ＋ 添加条目 entry（顺序即替补顺序）
            </button>
          </div>
        ))}
        <button style={button}
          onClick={() => mutate({ ...config, groups: [...groups, { id: 'group-' + (groups.length + 1), entries: [{ provider: '', model: '' }] }] })}>
          ＋ 添加分组 add group
        </button>
      </section>

      <section style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={label}>冷却（分钟）cooldown</span>
          <input style={input} type="number" min={1} value={config.cooldownMinutes ?? 30}
            onChange={(e) => mutate({ ...config, cooldownMinutes: Number(e.target.value) || 30 })} />
        </label>
        <div style={{ display: 'grid', gap: 4 }}>
          <span style={label}>触发切换的错误类别 retry on</span>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {RETRY_CLASSES.map((klass) => (
              <label key={klass} style={muted}>
                <input type="checkbox" checked={(config.retryOn ?? RETRY_CLASSES).includes(klass)}
                  onChange={(e) => {
                    const current = new Set(config.retryOn ?? RETRY_CLASSES)
                    if (e.target.checked) current.add(klass)
                    else current.delete(klass)
                    mutate({ ...config, retryOn: [...current] })
                  }} /> {klass}
              </label>
            ))}
          </div>
        </div>
      </section>

      <footer style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button style={{ ...button, fontWeight: 600 }} disabled={busy || !writable} onClick={() => void save()}>
          {busy ? '保存中…' : '保存 / Save'}
        </button>
        <span style={muted}>{status}{!writable ? '（只读 / read-only）' : ''}</span>
      </footer>
    </div>
  )
}

/** The remote face this card consumes (structural subset of ctx.remote). */
interface RemoteFace {
  settings: {
    describe(): Promise<{ ok: boolean, value?: { namespaces?: NamespaceView[] }, error?: { message?: string } }>
    update(ns: string, value: FailoverConfig, revision?: number): Promise<{ ok: boolean, value?: { namespaces?: NamespaceView[] }, error?: { message?: string } }>
  }
}

/** Browser plugin body. */
export const inject = ['slots', 'remote']

export function apply(ctx: { slots: SlotsFace, remote: RemoteFace, effect?: (fn: () => () => void, label?: string) => void }): void {
  const register = (): (() => void) => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item',
    id: 'model-failover',
    order: 40,
    label: () => 'Model Failover 模型替补',
  }, (props: { view?: string }) => <FailoverCard {...props} remote={ctx.remote} />))
  if (ctx.effect !== undefined) {
    ctx.effect(register, 'model-failover: plugins card')
  } else {
    register()
  }
}

/** Structural subset of the browser slots service. */
interface SlotsFace {
  inject(key: string, factory: () => () => void): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}
