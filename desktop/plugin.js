/**
 * CPA Quota v4 — 'AI Subscriptions' pane + statusbar chip.
 *
 * Consumes the v4 connector endpoints:
 *  - GET /quota            → Antigravity provider buckets (per-window remaining +
 *                            reset countdown) plus OpenCode Go rolling/weekly/monthly
 *                            usage when the backend reports it.
 *  - GET /providers        → all connector providers ({id, label, kind, connected,
 *                            detail}) rendered as a 'Subscriptions' section with a
 *                            small per-provider Connect button (oauth/import kinds).
 *  - POST /connect         → {provider} (+{file} for vertex imports) → auth_url.
 *  - GET /connect/status   → polled every 2s while connecting; completion
 *                            (new_file or error) clears the flow and invalidates
 *                            the quota + providers queries.
 *
 * The connect flow is inline (no modal): auth_url opens in a new tab while the
 * pane polls, and the backend output tail is shown in a mono pre block.
 *
 * Degrades gracefully against older backends:
 *  - `buckets` missing/empty → the flat `models` list is grouped client-side by
 *    (remaining, reset_in_seconds) into pseudo-buckets, so the UI still shows one
 *    row per quota window instead of one row per model.
 *  - `opencode_usage` missing → the OpenCode Go section is omitted entirely.
 *  - /providers missing/404  → the 'Subscriptions' section is omitted entirely.
 *
 * Install: folder name must equal id 'cpa-quota'.
 */

import * as React from 'react'
import { cn, haptic, Tip, useQuery, useQueryClient } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'cpa-quota'

// Backend-supplied auth URLs become clickable links in the renderer — only
// http(s) is acceptable; anything else is dropped before it can be rendered.
function isSafeUrl(u) {
  if (typeof u !== 'string' || !u) return false
  try {
    const p = new URL(u)
    return p.protocol === 'http:' || p.protocol === 'https:'
  } catch {
    return false
  }
}

// --- formatting helpers -----------------------------------------------------
function pct(f) {
  if (f == null) return '–'
  return Math.round(f * 100) + '%'
}

function countdown(sec) {
  if (sec == null || sec < 0) return ''
  if (sec < 60) return sec + 's'
  if (sec < 3600) return Math.floor(sec / 60) + 'm'
  return Math.floor(sec / 3600) + 'h' + String(Math.floor((sec % 3600) / 60)).padStart(2, '0') + 'm'
}

// --- visual language -------------------------------------------------------
// Brand accent per provider; bars/tone shift green → amber → red as the
// remaining fraction drops (inline styles only — desktop has no Tailwind).
const BRAND = {
  antigravity: '#4285F4',
  'opencode-go': '#2dd4bf',
  claude: '#f97316',
  codex: '#22c55e',
  kimi: '#a78bfa',
  xai: '#e5e7eb',
  vertex: '#60a5fa'
}
const brandColor = id => BRAND[id] || '#94a3b8'
function barTone(frac) {
  if (frac == null || Number.isNaN(frac)) return { a: '#475569', b: '#94a3b8' }
  if (frac >= 0.5) return { a: '#16a34a', b: '#4ade80' }
  if (frac >= 0.25) return { a: '#d97706', b: '#fbbf24' }
  return { a: '#dc2626', b: '#f87171' }
}
function toneColor(frac) {
  if (frac == null || Number.isNaN(frac)) return ''
  if (frac >= 0.5) return '#4ade80'
  if (frac >= 0.25) return '#fbbf24'
  return '#f87171'
}
function barStyle(frac, height) {
  const c = barTone(frac)
  return {
    height: height || 8,
    borderRadius: 999,
    background: `linear-gradient(90deg, ${c.a}, ${c.b})`,
    boxShadow: `0 0 10px ${c.a}55`,
    width: `${frac == null ? 0 : Math.min(100, Math.max(0, frac * 100))}%`,
    transition: 'width .5s ease'
  }
}

// Epoch timestamp (ms or seconds) → whole seconds until it (0 once past).
function secsUntil(ts, nowMs) {
  if (ts == null || typeof ts !== 'number') return null
  const t = ts > 1e12 ? ts : ts * 1000
  return Math.max(0, Math.floor((t - nowMs) / 1000))
}

// Backend `reset_in_seconds` is relative to server ts → adjust for local clock.
function liveReset(sec, nowMs, serverTs) {
  if (sec == null) return null
  const localDelta = serverTs ? Math.floor(nowMs / 1000) - serverTs : 0
  return Math.max(0, sec - localDelta)
}

// Ticks every second so countdowns move; passes the local clock to children.
function Now({ render }) {
  const [now, setNow] = React.useState(Date.now())
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return render(now)
}

// --- data helpers -----------------------------------------------------------
// v3 buckets, or a client-side fallback grouping the flat model list by
// (remaining, reset_in_seconds) so stale backends still render one row per
// quota window. Each pseudo-bucket keeps its model list for the expandable
// "n models" toggle.
function deriveBuckets(models) {
  const groups = new Map()
  for (const m of models || []) {
    if (m.remaining == null) continue
    const key = String(m.remaining) + '|' + String(m.reset_in_seconds != null ? m.reset_in_seconds : '')
    if (!groups.has(key)) {
      groups.set(key, {
        id: 'derived-' + (m.id || groups.size),
        display_name: m.display_name || m.id || 'bucket',
        remaining: m.remaining,
        reset_in_seconds: m.reset_in_seconds != null ? m.reset_in_seconds : null,
        models: []
      })
    }
    groups.get(key).models.push(m)
  }
  return Array.from(groups.values())
}

function bucketsOf(data) {
  const bs = (data && data.buckets) || []
  return bs.length ? bs : deriveBuckets(data && data.models)
}

function lowestOf(buckets) {
  if (!buckets || !buckets.length) return null
  return buckets.reduce((a, b) => {
    const ar = a.remaining != null ? a.remaining : 1
    const br = b.remaining != null ? b.remaining : 1
    return br < ar ? b : a
  })
}

function thresholdOf(data) {
  return data && data.config && data.config.low_threshold != null ? data.config.low_threshold : 0.1
}

function opencodeOf(data) {
  const u = data && data.opencode_usage
  return u && u.ok ? u : null
}

// v4: GET /providers → array of {id, label, kind, connected, detail}, or
// null when the endpoint is missing/404 (old backend) → section omitted.
function providersOf(data) {
  if (Array.isArray(data)) return data
  if (data && Array.isArray(data.providers)) return data.providers
  return null
}

// Last n lines of a backend output string (progress logs during connect).
function tailOf(out, n) {
  if (!out) return ''
  const s = String(out)
  const lines = s.split('\n')
  return lines.length > n ? '…\n' + lines.slice(-n).join('\n') : s
}

// Shared query: refresh cadence comes from the backend config once known.
function useQuota() {
  return useQuery({
    queryKey: [ID, 'quota'],
    queryFn: async () => ctxRest('/quota', { method: 'GET', timeoutMs: 15000 }),
    refetchInterval: q => {
      const cfg = q && q.state && q.state.data && q.state.data.config
      return ((cfg && cfg.refresh_interval_seconds) || 60) * 1000
    },
    refetchIntervalInBackground: false,
    staleTime: 30 * 1000
  })
}

// v4: providers list, fixed 60s cadence. Stops polling while errored so an
// old backend without /providers isn't hammered.
function useProviders() {
  return useQuery({
    queryKey: [ID, 'providers'],
    queryFn: async () => ctxRest('/providers', { method: 'GET', timeoutMs: 15000 }),
    refetchInterval: q => (q && q.state && q.state.status === 'error' ? false : 60 * 1000),
    refetchIntervalInBackground: false,
    staleTime: 30 * 1000,
    retry: 1
  })
}

// --- chip -------------------------------------------------------------------
function QuotaChip() {
  const qc = useQueryClient()
  const { data, isError } = useQuota()
  const lowest = lowestOf(bucketsOf(data))
  const frac = lowest ? lowest.remaining : null
  const threshold = thresholdOf(data)
  const warn = isError || (frac != null && frac < threshold)

  return jsx(Now, {
    render: nowMs => {
      const live = frac == null ? null : liveReset(lowest.reset_in_seconds, nowMs, data && data.ts)
      const label = isError
        ? '⚠ quota?'
        : frac == null
          ? '◇ quota'
          : `◇ ${pct(frac)} · ${countdown(live)}`
      return jsx(Tip, {
        label: 'CPA Quota: lowest window left · click to refresh',
        children: jsx('button', {
          className: cn(
            'inline-flex h-full items-center gap-1 px-1.5 font-mono text-[0.6875rem] transition-colors',
            'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-primary)',
            warn && !isError && frac != null && 'text-(--ui-accent)'
          ),
          style:
            isError
              ? { color: '#f87171', textShadow: '0 0 12px #f8717166' }
              : frac != null && !warn
                ? { color: toneColor(frac), textShadow: `0 0 12px ${toneColor(frac)}66` }
                : frac != null
                  ? { color: '#f87171', textShadow: '0 0 12px #f8717166' }
                  : undefined,
          type: 'button',
          title: lowest
            ? `${lowest.display_name}: ${pct(frac)} left, resets in ${countdown(live)}`
            : 'CPA Quota',
          onClick: () => {
            haptic('tap')
            qc.invalidateQueries({ queryKey: [ID, 'quota'] })
          },
          children: label
        })
      })
    }
  })
}

// --- pane -------------------------------------------------------------------
// One Antigravity quota window: remaining bar, countdown, expandable model list.
function BucketRow({ b, nowMs, serverTs, threshold, open, onToggle }) {
  const frac = b.remaining
  const live = liveReset(b.reset_in_seconds, nowMs, serverTs)
  const models = b.models || []
  const low = frac != null && frac < threshold
  const modelToggle = models.length
    ? (open ? '▾ ' : '▸ ') + models.length + ' model' + (models.length === 1 ? '' : 's')
    : ''

  return jsxs('div', {
    className: 'flex flex-col gap-1 rounded-md border border-(--ui-stroke-secondary) px-2.5 py-1.5',
    style: { borderLeft: `3px solid ${barTone(frac).a}` },
    children: [
      jsxs('button', {
        type: 'button',
        onClick: () => {
          haptic('tap')
          onToggle()
        },
        className: 'flex w-full items-center gap-1.5 text-xs',
        children: [
          jsx('span', { className: 'truncate font-medium text-(--ui-text-primary)', title: b.id, children: b.display_name }),
          modelToggle &&
            jsx('span', { className: 'shrink-0 text-[10px] text-(--ui-text-quaternary)', children: modelToggle }),
          jsx('span', {
            className: 'ml-auto shrink-0 font-mono text-[11px] font-semibold',
            style: frac != null ? { color: toneColor(frac) } : undefined,
            children: pct(frac)
          }),
          jsx('span', {
            className: cn('shrink-0 font-mono text-[11px]', low ? 'text-(--ui-accent)' : 'text-(--ui-text-tertiary)'),
            children: live != null && frac != null ? '⏱ ' + countdown(live) : ''
          })
        ]
      }),
      jsx('div', {
        className: 'w-full overflow-hidden rounded-full bg-(--chrome-action-hover)',
        style: { height: 8 },
        children: frac == null
          ? null
          : jsx('div', { style: barStyle(frac) })
      }),
      open && models.length > 0 &&
        jsx('div', {
          className: 'text-[10px] leading-relaxed text-(--ui-text-quaternary)',
          children: models.map(m => m.id).join(', ')
        })
    ]
  })
}

// OpenCode Go usage line: used% + reset countdown (+ tone bar).
function OcRow({ label, d, nowMs }) {
  if (!d) return null
  const usedNum = d.percent != null
    ? Math.min(100, Math.max(0, d.percent))
    : d.remaining_fraction != null
      ? Math.round((1 - d.remaining_fraction) * 100)
      : null
  const used = usedNum != null ? Math.round(usedNum) + '%' : null
  const reset = secsUntil(d.resetsAt, nowMs)
  const tone = barTone(usedNum == null ? null : (100 - usedNum) / 100)
  return jsxs('div', {
    className: 'flex flex-col gap-1 rounded-md border border-(--ui-stroke-secondary) px-2.5 py-1 text-[11px]',
    style: { borderLeft: `3px solid ${tone.a}` },
    children: [
      jsxs('div', {
        className: 'flex items-center gap-1.5',
        children: [
          jsx('span', { className: 'font-medium text-(--ui-text-primary)', children: label }),
          d.status && jsx('span', { className: 'text-[10px] uppercase text-(--ui-text-quaternary)', children: d.status }),
          jsx('span', {
            className: 'ml-auto shrink-0 font-mono text-(--ui-text-secondary)',
            style: usedNum != null ? { color: tone.a } : undefined,
            children: used || '–'
          }),
          reset != null &&
            jsx('span', { className: 'shrink-0 font-mono text-[10px] text-(--ui-text-tertiary)', children: '⏱ ' + countdown(reset) })
        ]
      }),
      usedNum != null &&
        jsx('div', {
          className: 'w-full overflow-hidden rounded-full bg-(--chrome-action-hover)',
          style: { height: 6 },
          children: jsx('div', { style: Object.assign(barStyle((100 - usedNum) / 100, 6), { width: usedNum + '%' }) })
        })
    ]
  })
}

// Collapsible provider summary row (accordion — one detail open at a time).
function ProviderRow({ name, dot, main, sub, open, onClick }) {
  return jsxs('button', {
    type: 'button',
    onClick: () => {
      haptic('tap')
      onClick()
    },
    className: cn(
      'flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs',
      'border-(--ui-stroke-secondary) hover:bg-(--chrome-action-hover)',
      open && 'border-(--ui-accent)'
    ),
    children: [
      jsx('span', { className: 'inline-block h-2 w-2 shrink-0 rounded-full', style: { background: dot } }),
      jsx('span', { className: 'shrink-0 font-medium text-(--ui-text-primary)', children: name }),
      jsx('span', { className: 'ml-auto shrink-0 font-mono text-[11px] text-(--ui-text-secondary)', children: main }),
      jsx('span', { className: 'shrink-0 font-mono text-[11px] text-(--ui-text-tertiary)', children: sub }),
      jsx('span', { className: 'shrink-0 text-[10px] text-(--ui-text-quaternary)', children: open ? '▾' : '▸' })
    ]
  })
}

// v4: one provider row in the 'Subscriptions' section — status dot + detail
// (truncated) + a small Connect button for oauth/import kinds when not connected.
function SubRow({ p, connecting, onConnect }) {
  const canConnect = p.kind === 'oauth' || p.kind === 'import'
  const accent = brandColor(p.id)
  return jsxs('div', {
    className: 'flex items-center gap-1.5 rounded-md border border-(--ui-stroke-secondary) px-2.5 py-1 text-[11px]',
    style: { borderLeft: `3px solid ${p.connected ? '#22c55e' : accent}` },
    children: [
      jsx('span', {
        className: cn('shrink-0 font-mono text-[10px]', p.connected ? '' : 'opacity-60'),
        style: p.connected ? { color: '#22c55e' } : { color: accent },
        children: p.connected ? '●' : '○'
      }),
      jsx('span', { className: 'shrink-0 font-medium text-(--ui-text-primary)', children: p.label || p.id }),
      jsx('span', {
        className: 'min-w-0 flex-1 truncate text-[10px] text-(--ui-text-tertiary)',
        title: p.detail || '',
        children: p.detail || ''
      }),
      canConnect && !p.connected &&
        jsx('button', {
          type: 'button',
          disabled: !!connecting,
          title: 'Connect ' + (p.label || p.id),
          className: cn(
            'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
            'disabled:cursor-default disabled:opacity-40'
          ),
          style: { backgroundColor: accent, color: '#fff' },
          onClick: onConnect,
          children: 'Connect'
        })
    ]
  })
}

function QuotaPane() {
  const qc = useQueryClient()
  const { data, isError, isLoading } = useQuota()
  const prov = useProviders()
  const [openProv, setOpenProv] = React.useState(null) // 'antigravity' | 'opencode'
  const [openBucket, setOpenBucket] = React.useState(null)
  const [connecting, setConnecting] = React.useState(null) // {provider, state:'file'|'pending'|'url'|'error', url?, output?, error?}
  const [filePath, setFilePath] = React.useState('')
  const connectToken = React.useRef(0)

  const buckets = bucketsOf(data)
  const lowest = lowestOf(buckets)
  const threshold = thresholdOf(data)
  const oc = opencodeOf(data)
  const rolling = oc && oc.rolling ? oc.rolling : null
  const alerts = (data && data.alerts) || []

  // /providers is v4-only — omit the 'Subscriptions' section on 404/missing.
  const providers = providersOf(prov.data)
  const showSubs = !prov.isError && providers !== null && providers.length > 0

  const polling = connecting && connecting.state === 'url'
  const connectUrl = polling ? connecting.url : null
  const safeConnectUrl = isSafeUrl(connectUrl) ? connectUrl : null
  const unsafeUrl = connectUrl && !safeConnectUrl ? connectUrl : null

  // While an auth URL is open, poll /connect/status every 2s; completion
  // (new_file or error) clears the flow and invalidates both queries.
  React.useEffect(() => {
    if (!polling) return
    let failures = 0
    const fail = () => {
      failures++
      if (failures >= 4) {
        // ~8s of persistent failure — stop polling and surface an error
        setConnecting(c =>
          c && c.state === 'url'
            ? { ...c, state: 'error', error: 'status polling failed: backend unreachable' }
            : c
        )
      }
    }
    const t = setInterval(async () => {
      try {
        const st = await ctxRest('/connect/status', { method: 'GET', timeoutMs: 10000 })
        if (!st) {
          fail()
          return
        }
        failures = 0
        if (st.error) {
          // backend reported a failed OAuth/import — show the message and keep
          // the card up so the user can read it before cancelling.
          qc.invalidateQueries({ queryKey: [ID, 'quota'] })
          qc.invalidateQueries({ queryKey: [ID, 'providers'] })
          setConnecting(c => (c && c.state === 'url' ? { ...c, state: 'error', error: st.error } : c))
          return
        }
        if (st.new_file || st.status === 'connected') {
          qc.invalidateQueries({ queryKey: [ID, 'quota'] })
          qc.invalidateQueries({ queryKey: [ID, 'providers'] })
          setConnecting(null)
          return
        }
        if (st.output != null) {
          setConnecting(c => (c && c.state === 'url' ? { ...c, output: st.output } : c))
        }
      } catch (e) {
        // transient polling failure — keep trying up to the cap
        fail()
      }
    }, 2000)
    return () => clearInterval(t)
  }, [polling, qc])

  const toggleProv = p => setOpenProv(openProv === p ? null : p)

  const doConnect = async (providerId, file) => {
    const token = ++connectToken.current
    haptic('tap')
    setConnecting({ provider: providerId, state: 'pending', output: '' })
    try {
      const body = file != null ? { provider: providerId, file } : { provider: providerId }
      const res = await ctxRest('/connect', { method: 'POST', body, timeoutMs: 15000 })
      if (token !== connectToken.current) return // cancelled while POST in flight
      if (res && res.new_file) {
        // import-style connect completed synchronously
        qc.invalidateQueries({ queryKey: [ID, 'quota'] })
        qc.invalidateQueries({ queryKey: [ID, 'providers'] })
        setConnecting(null)
        return
      }
      const rawUrl = res && (res.auth_url || res.url || res.authorize_url || (res.data && res.data.auth_url))
      const url = isSafeUrl(rawUrl) ? rawUrl : null
      if (url) {
        setConnecting({ provider: providerId, state: 'url', url, output: (res && res.output) || '' })
        return
      }
      if (rawUrl && !url) {
        // non-http(s) auth_url from the backend — drop it and fail loudly
        setConnecting({ provider: providerId, state: 'error', error: 'unsafe auth_url scheme rejected' })
        return
      }
      if (res && res.output && !res.error) {
        // device-code style flow without a URL — poll for completion anyway
        setConnecting({ provider: providerId, state: 'url', url: null, output: res.output })
        return
      }
      setConnecting({ provider: providerId, state: 'error', error: (res && res.error) || 'no auth_url returned' })
    } catch (e) {
      if (token !== connectToken.current) return
      setConnecting({ provider: providerId, state: 'error', error: (e && e.message) || String(e) })
    }
  }

  const startConnect = p => {
    haptic('tap')
    if (connecting) return // only one connect at a time
    if (p.kind === 'import') {
      // vertex & co: ask for the credentials file path first
      setFilePath('')
      setConnecting({ provider: p.id, state: 'file', output: '' })
      return
    }
    doConnect(p.id)
  }

  const cancelConnect = () => {
    haptic('tap')
    connectToken.current++
    setConnecting(null)
  }

  const cp = connecting && providers ? providers.find(x => x.id === connecting.provider) : null
  const cpLabel = connecting ? (cp ? cp.label : connecting.provider) : ''

  return jsxs('div', {
    className: 'flex h-full flex-col gap-2 overflow-hidden p-2.5 text-sm',
    children: [
      jsxs('div', {
        className: 'flex shrink-0 items-center gap-2',
        children: [
          jsx('span', {
            className: 'text-xs font-semibold tracking-wide text-(--ui-text-secondary)',
            style: { color: brandColor('antigravity') },
            children: '◆ '
          }),
          jsx('span', { className: 'text-xs font-semibold tracking-wide text-(--ui-text-secondary)', children: 'AI SUBSCRIPTIONS' }),
          jsx('span', { className: 'truncate text-[11px] text-(--ui-text-quaternary)', children: (data && data.account) || '' }),
          jsx('span', { className: 'flex-1' }),
          jsx('button', {
            type: 'button',
            title: 'Refresh',
            className: 'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-xs text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-primary)',
            onClick: () => {
              haptic('tap')
              qc.invalidateQueries({ queryKey: [ID, 'quota'] })
            },
            children: '⟳'
          })
        ]
      }),
      isError &&
        jsx('div', { className: 'shrink-0 text-xs text-(--ui-accent)', children: 'backend unreachable: is cpa-quota enabled in plugins.enabled?' }),
      data && data.error && data.ok !== true &&
        jsx('div', { className: 'shrink-0 text-xs text-(--ui-accent)', children: '⚠ ' + data.error }),
      data && data.error && data.ok === true &&
        jsx('div', { className: 'shrink-0 truncate text-[11px] text-(--ui-text-quaternary)', title: data.error, children: '⚠ ' + data.error }),
      isLoading && !data &&
        jsx('div', { className: 'shrink-0 text-xs text-(--ui-text-quaternary)', children: 'loading quota…' }),
      jsx(Now, {
        render: nowMs => {
          const antigravityMain = lowest ? pct(lowest.remaining) : '–'
          const antigravitySub = lowest
            ? countdown(liveReset(lowest.reset_in_seconds, nowMs, data && data.ts))
            : ''
          const ocFrac = rolling
            ? rolling.remaining_fraction != null
              ? rolling.remaining_fraction
              : rolling.percent != null ? (100 - rolling.percent) / 100 : null
            : null
          const ocMain = ocFrac != null ? pct(ocFrac) : '–'
          const ocSub = rolling ? countdown(secsUntil(rolling.resetsAt, nowMs)) : ''

          return jsxs('div', {
            className: 'flex flex-1 flex-col gap-1.5 overflow-y-auto',
            children: [
              jsx(ProviderRow, {
                name: 'Antigravity',
                dot: data && !isError ? brandColor('antigravity') : '#64748b',
                main: antigravityMain,
                sub: antigravitySub,
                open: openProv === 'antigravity',
                onClick: () => toggleProv('antigravity')
              }),
              openProv === 'antigravity' && buckets.length > 0 &&
                jsxs('div', {
                  className: 'flex flex-col gap-1 pl-1',
                  children: buckets.map(b =>
                    jsx(BucketRow, {
                      b,
                      nowMs,
                      serverTs: data && data.ts,
                      threshold,
                      open: openBucket === b.id,
                      onToggle: () => setOpenBucket(openBucket === b.id ? null : b.id)
                    }, b.id)
                  )
                }),
              oc &&
                jsx(ProviderRow, {
                  name: 'OpenCode Go',
                  dot: oc ? brandColor('opencode-go') : '#64748b',
                  main: ocMain,
                  sub: ocSub,
                  open: openProv === 'opencode',
                  onClick: () => toggleProv('opencode')
                }),
              openProv === 'opencode' && oc &&
                jsxs('div', {
                  className: 'flex flex-col gap-1 pl-1',
                  children: [
                    jsx(OcRow, { label: 'rolling', d: oc.rolling, nowMs }),
                    jsx(OcRow, { label: 'weekly', d: oc.weekly, nowMs }),
                    jsx(OcRow, { label: 'monthly', d: oc.monthly, nowMs })
                  ]
                }),
              alerts.length > 0 &&
                jsxs('div', {
                  className: 'flex flex-col gap-0.5',
                  children: alerts.map(a =>
                    jsx('div', {
                      className: 'text-[10px] text-(--ui-accent)',
                      children: '⚠ ' + (typeof a === 'string' ? a : a.message || a.text || JSON.stringify(a))
                    }, typeof a === 'string' ? a : a.message || 'alert')
                  )
                }),
              showSubs &&
                jsxs('div', {
                  className: 'flex flex-col gap-1.5',
                  children: [
                    jsx('div', { className: 'text-[10px] font-semibold uppercase tracking-wide text-(--ui-text-quaternary)', children: 'Subscriptions' }),
                    providers.map(p =>
                      jsx(SubRow, {
                        p,
                        connecting,
                        onConnect: () => startConnect(p)
                      }, p.id)
                    ),
                    connecting &&
                      (connecting.state === 'file'
                        ? jsxs('div', {
                            className: 'flex flex-col gap-1 rounded-md border border-(--ui-accent) px-2.5 py-1.5',
                            style: { borderColor: brandColor(connecting.provider) },
                            children: [
                              jsx('div', { className: 'text-[10px] text-(--ui-text-quaternary)', children: cpLabel + ': path to credentials file:' }),
                              jsxs('div', {
                                className: 'flex items-center gap-1',
                                children: [
                                  jsx('input', {
                                    type: 'text',
                                    value: filePath,
                                    placeholder: '/path/to/service-account.json',
                                    onChange: e => setFilePath(e.target.value),
                                    onKeyDown: e => {
                                      if (e.key === 'Enter') {
                                        e.preventDefault()
                                        const v = filePath.trim()
                                        if (v) doConnect(connecting.provider, v)
                                      }
                                    },
                                    className: 'min-w-0 flex-1 rounded border border-(--ui-stroke-secondary) bg-transparent px-1.5 py-0.5 font-mono text-[10px] text-(--ui-text-primary) outline-none focus:border-(--ui-accent)'
                                  }),
                                  jsx('button', {
                                    type: 'button',
                                    disabled: !filePath.trim(),
                                    onClick: () => doConnect(connecting.provider, filePath.trim()),
                                    className: 'shrink-0 rounded border border-(--ui-stroke-secondary) px-1.5 py-0.5 text-[10px] text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-primary) disabled:opacity-40',
                                    children: 'Import'
                                  }),
                                  jsx('button', { type: 'button', onClick: cancelConnect, className: 'shrink-0 text-[10px] text-(--ui-text-quaternary) underline', children: 'cancel' })
                                ]
                              })
                            ]
                          })
                        : connecting.state === 'pending'
                          ? jsxs('div', {
                              className: 'flex flex-col gap-1 rounded-md border border-(--ui-accent) px-2.5 py-1.5',
                              style: { borderColor: brandColor(connecting.provider) },
                              children: [
                                jsx('span', { className: 'text-xs text-(--ui-text-tertiary)', children: cpLabel + ': connecting…' }),
                                jsx('button', { type: 'button', onClick: cancelConnect, className: 'w-fit text-[10px] text-(--ui-text-quaternary) underline', children: 'cancel' })
                              ]
                            })
                          : connecting.state === 'url'
                            ? jsxs('div', {
                                className: 'flex flex-col gap-1 rounded-md border border-(--ui-accent) px-2.5 py-1.5',
                                style: { borderColor: brandColor(connecting.provider) },
                                children: [
                                  jsx('div', { className: 'text-[10px] text-(--ui-text-quaternary)', children: 'Open in your browser: this pane polls for the callback:' }),
                                  safeConnectUrl &&
                                    jsx('a', {
                                      href: safeConnectUrl,
                                      target: '_blank',
                                      rel: 'noreferrer',
                                      title: safeConnectUrl,
                                      className: 'truncate text-[11px] text-(--ui-accent) underline',
                                      children: safeConnectUrl
                                    }),
                                  unsafeUrl &&
                                    jsx('span', {
                                      title: 'auth_url rejected: not http(s)',
                                      className: 'truncate text-[11px] text-(--ui-text-quaternary)',
                                      children: unsafeUrl
                                    }),
                                  connecting.output &&
                                    jsx('pre', {
                                      style: { maxHeight: 100 },
                                      className: 'overflow-y-auto whitespace-pre-wrap break-all rounded border border-(--ui-stroke-secondary) bg-(--chrome-action-hover) px-1.5 py-1 font-mono text-[10px] leading-snug text-(--ui-text-secondary)',
                                      children: tailOf(connecting.output)
                                    }),
                                  jsxs('div', {
                                    className: 'flex items-center gap-2 text-[10px] text-(--ui-text-quaternary)',
                                    children: [
                                      jsx('span', { children: 'polling every 2s…' }),
                                      jsx('button', { type: 'button', onClick: cancelConnect, className: 'underline', children: 'cancel' })
                                    ]
                                  })
                                ]
                              })
                            : jsxs('div', {
                                className: 'flex flex-col gap-1 rounded-md border border-(--ui-accent) px-2.5 py-1.5',
                                style: { borderColor: brandColor(connecting.provider) },
                                children: [
                                  jsx('span', { className: 'text-xs text-(--ui-accent)', children: '⚠ ' + (connecting.error || 'connect failed') }),
                                  jsx('button', { type: 'button', onClick: cancelConnect, className: 'w-fit text-[10px] text-(--ui-text-quaternary) underline', children: 'cancel' })
                                ]
                              }))
                  ]
                }),
              !isLoading && data && buckets.length === 0 && !oc &&
                jsx('div', { className: 'text-[10px] text-(--ui-text-quaternary)', children: 'no quota data reported yet' })
            ]
          })
        }
      }),
      jsx('div', {
        className: 'shrink-0 border-t border-(--ui-stroke-secondary) pt-1 text-[10px] text-(--ui-text-quaternary)',
        children: 'remaining = fraction of current window · resets per bucket'
      })
    ]
  })
}

// ctx.rest is captured at register-time (see pixel-office pattern).
let ctxRest = async () => { throw new Error('not registered') }

export default {
  id: ID,
  name: 'CPA Quota',
  register(ctx) {
    ctxRest = (path, opts) => ctx.rest(path, opts)

    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 200,
      render: () => jsx(QuotaChip, {})
    })

    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'CPA Quota',
      data: { placement: 'right', width: '320px' },
      render: () => jsx(QuotaPane, {})
    })
  }
}
