/**
 * CPA Quota — web dashboard plugin (tab page + header chip) v4 "Subscriptions".
 *
 * General-purpose subscription connector GUI for CLIProxyAPI:
 *   - top row: page title + Refresh only (small ⚙ opens a minimal settings
 *     popover next to Refresh)
 *   - provider cards (grid-cols-2), ONE PER PROVIDER from GET /providers:
 *     label + kind tag (OAuth / API key / Import), '● connected' with the
 *     auth-file detail or '○ not connected' with a bg-primary Connect
 *     button; a running connect shows 'Connecting…' on its own card and
 *     disables every other Connect button while it runs
 *   - Antigravity card additionally shows the lowest-bucket remaining% +
 *     reset countdown and its accordion detail with quota bucket cards;
 *     OpenCode Go keeps the rolling-window summary and the rolling /
 *     weekly / monthly accordion — both exactly as in v3
 *   - universal ConnectModal (replaces the old add-subscription panel):
 *     POST /connect {provider} on open (vertex instead takes a .json file
 *     path + Import), then watches GET /connect/status every 2s — auth_url
 *     link, live output tail, Cancel while running, auto-close + reload of
 *     providers/quota on success
 *   - settings popover: refresh interval + alert threshold + Advanced
 *     (hosts / auth dir) via PUT /config; header chip with lowest bucket /
 *     primary model + countdown, ⚠ when under the threshold, click to
 *     refresh
 *
 * Defensive: derives buckets client-side from models when the backend has
 * no `buckets`; hides the OpenCode Go card when `opencode_usage` is
 * missing; treats GET /providers as optional — on old backends (404 /
 * empty) it falls back to the v3 hub (antigravity + opencode cards only).
 *
 * No build step — plain IIFE, classic <script> tag. Classes are restricted
 * to the set compiled into web_dist (theme tokens, no hardcoded colors);
 * anything dynamic uses inline style.
 */
(function () {
  'use strict'

  var NAME = 'cpa-quota'
  var SDK = window.__HERMES_PLUGIN_SDK__
  if (!SDK) return

  var React = SDK.React
  var hooks = SDK.hooks
  var utils = SDK.utils
  var useState = hooks.useState
  var useEffect = hooks.useEffect
  var useCallback = hooks.useCallback
  var useRef = hooks.useRef || function () { return { current: null } }
  var cn = utils.cn
  var API = '/api/plugins/cpa-quota/'
  var CONNECT_POLL_MS = 2000

  // --- helpers -------------------------------------------------------------
  function pct(f) {
    if (f == null || isNaN(f)) return '—'
    return Math.round(f * 100) + '%'
  }

  function countdown(sec) {
    if (sec == null || sec < 0 || isNaN(sec)) return ''
    if (sec < 60) return sec + 's'
    if (sec < 3600) return Math.floor(sec / 60) + 'm'
    return Math.floor(sec / 3600) + 'h' + String(Math.floor((sec % 3600) / 60)).padStart(2, '0') + 'm'
  }

  // --- visual language ----------------------------------------------------
  // Brand accent per provider; bars/tone shift green → amber → red as the
  // remaining fraction drops. All applied via inline styles — the host CSS
  // is compiled at build time, so runtime classes must stay whitelisted.
  var BRAND = {
    antigravity: '#4285F4',
    'opencode-go': '#2dd4bf',
    claude: '#f97316',
    codex: '#22c55e',
    kimi: '#a78bfa',
    xai: '#e5e7eb',
    vertex: '#60a5fa'
  }
  function brandColor(id) {
    return BRAND[id] || '#94a3b8'
  }
  function barTone(frac) {
    if (frac == null || isNaN(frac)) return { a: '#475569', b: '#94a3b8' }
    if (frac >= 0.5) return { a: '#16a34a', b: '#4ade80' }
    if (frac >= 0.25) return { a: '#d97706', b: '#fbbf24' }
    return { a: '#dc2626', b: '#f87171' }
  }
  function usedTone(used) {
    // opencode-style: `used` is percent consumed — invert to remaining
    return barTone(used == null ? null : (100 - used) / 100)
  }
  function toneColor(frac) {
    if (frac == null || isNaN(frac)) return ''
    if (frac >= 0.5) return '#4ade80'
    if (frac >= 0.25) return '#fbbf24'
    return '#f87171'
  }
  function barStyle(frac, height) {
    var c = barTone(frac)
    return {
      height: height || 8,
      borderRadius: 999,
      background: 'linear-gradient(90deg,' + c.a + ',' + c.b + ')',
      boxShadow: '0 0 10px ' + c.a + '55',
      width: (frac == null ? 0 : Math.min(100, Math.max(0, frac * 100))) + '%',
      transition: 'width .5s ease'
    }
  }

  // seconds until `reset_in_seconds` (server-relative), ticking with nowMs
  function liveReset(resetInSeconds, serverTs, nowMs) {
    if (resetInSeconds == null) return null
    var base = serverTs || Math.floor(nowMs / 1000)
    return Math.max(0, resetInSeconds - Math.floor(nowMs / 1000 - base))
  }

  // seconds until an ISO-8601 timestamp (opencode resetsAt)
  function timeUntilIso(iso, nowMs) {
    if (!iso) return null
    var t = new Date(iso).getTime()
    if (isNaN(t)) return null
    return Math.max(0, Math.floor((t - nowMs) / 1000))
  }

  function useNow() {
    var now = useState(Date.now())
    useEffect(function () {
      var t = setInterval(function () { now[1](Date.now()) }, 1000)
      return function () { clearInterval(t) }
    }, [])
    return now[0]
  }

  function usePoll(fn, intervalMs) {
    var state = useState(null)
    var error = useState(null)
    var reload = useCallback(function () {
      fn()
        .then(function (d) { state[1](d); error[1](null) })
        .catch(function (e) { error[1](String(e && e.message ? e.message : e)) })
    }, [])
    useEffect(function () {
      reload()
      var t = setInterval(reload, intervalMs)
      return function () { clearInterval(t) }
    }, [reload, intervalMs])
    return { data: state[0], error: error[0], reload: reload }
  }

  function apiGet(path) {
    return SDK.fetchJSON(API + path)
  }

  function apiPut(path, body) {
    return SDK.fetchJSON(API + path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    })
  }

  function apiPost(path, body) {
    var opts = { method: 'POST' }
    if (body) {
      opts.headers = { 'Content-Type': 'application/json' }
      opts.body = JSON.stringify(body)
    }
    return SDK.fetchJSON(API + path, opts)
  }

  // Backend-supplied auth URLs become clickable links — only http(s) is
  // acceptable; anything else (javascript:, data:, …) renders as plain text.
  // Mirrors the desktop plugin's isSafeUrl.
  function isSafeUrl(u) {
    if (typeof u !== 'string' || !u) return false
    try {
      var p = new URL(u)
      return p.protocol === 'http:' || p.protocol === 'https:'
    } catch (e) {
      return false
    }
  }

  // --- quota buckets -------------------------------------------------------
  // Fallback display name when the backend doesn't send one: infer the
  // family from the member model ids.
  function bucketDisplayName(ids) {
    var low = []
    for (var i = 0; i < ids.length; i++) low.push(String(ids[i]).toLowerCase())
    var allContain = function (needle) {
      for (var j = 0; j < low.length; j++) {
        if (low[j].indexOf(needle) === -1) return false
      }
      return true
    }
    if (allContain('gemini')) return 'Gemini models'
    if (allContain('claude') || allContain('gpt')) return 'Claude & GPT models'
    if (allContain('qwen')) return 'Qwen models'
    return 'Mixed models'
  }

  // Group the flat models list by exact (remaining, reset_time) window —
  // models sharing one window share one quota bucket.
  function deriveBuckets(models) {
    if (!Array.isArray(models) || !models.length) return null
    var groups = {}
    var order = []
    for (var i = 0; i < models.length; i++) {
      var m = models[i]
      if (!m) continue
      var key = String(m.remaining == null ? 'null' : m.remaining) + '|' + (m.reset_time || '')
      if (!groups[key]) { groups[key] = []; order.push(key) }
      groups[key].push(m)
    }
    var out = []
    for (var j = 0; j < order.length; j++) {
      var members = groups[order[j]]
      var ids = []
      var rem = null
      var rtime = ''
      var rsec = null
      for (var k = 0; k < members.length; k++) {
        var mm = members[k]
        ids.push(mm.id)
        if (rem == null && mm.remaining != null) rem = mm.remaining
        if (!rtime && mm.reset_time) rtime = mm.reset_time
        if (mm.reset_in_seconds != null) {
          rsec = rsec == null || mm.reset_in_seconds < rsec ? mm.reset_in_seconds : rsec
        }
      }
      out.push({
        id: 'derived-' + j,
        display_name: bucketDisplayName(ids),
        remaining: rem,
        reset_time: rtime,
        reset_in_seconds: rsec,
        models: ids,
        size: ids.length
      })
    }
    out.sort(function (a, b) {
      var ar = a.remaining == null ? 2 : a.remaining
      var br = b.remaining == null ? 2 : b.remaining
      return ar - br
    })
    return out
  }

  // Backend buckets when present, else derive from models (old backends).
  function getBuckets(data) {
    if (!data) return null
    if (Array.isArray(data.buckets) && data.buckets.length) return data.buckets
    return deriveBuckets(data.models)
  }

  function pickLowestBucket(buckets) {
    if (!Array.isArray(buckets) || !buckets.length) return null
    var best = null
    for (var i = 0; i < buckets.length; i++) {
      var b = buckets[i]
      if (!b || b.remaining == null) continue
      if (!best || b.remaining < best.remaining) best = b
    }
    return best || buckets[0] || null
  }

  function findBucketForModel(buckets, modelId) {
    if (!modelId || !Array.isArray(buckets)) return null
    for (var i = 0; i < buckets.length; i++) {
      var b = buckets[i]
      if (b && Array.isArray(b.models) && b.models.indexOf(modelId) !== -1) return b
    }
    return null
  }

  // --- provider list -------------------------------------------------------
  // Prefer GET /providers metadata when available (v4: one card per
  // subscription); on old backends derive the v3 two-card hub from the
  // quota payload instead.
  function buildProviderList(data, provData, nowMs) {
    var buckets = getBuckets(data)
    var lowest = pickLowestBucket(buckets)
    var antErr = data && data.ok === false ? (data.error || 'antigravity unavailable') : null
    var usage = data && data.opencode_usage

    function antSummary() {
      if (antErr) return null
      return lowest && lowest.remaining != null
        ? 'lowest ' + pct(lowest.remaining) + ' · resets in ' + countdown(liveReset(lowest.reset_in_seconds, data && data.ts, nowMs))
        : 'no quota data'
    }

    function ocSummary() {
      if (!usage || usage.ok === false) return null
      var rolling = usage.rolling && typeof usage.rolling === 'object' ? usage.rolling : null
      var rollFrac = null
      var rollReset = null
      if (rolling) {
        if (typeof rolling.percent === 'number') rollFrac = 1 - rolling.percent / 100
        else if (rolling.remaining_fraction != null) rollFrac = rolling.remaining_fraction
        rollReset = timeUntilIso(rolling.resetsAt, nowMs)
      }
      return rollFrac != null
        ? 'rolling ' + pct(rollFrac) + (rollReset != null ? ' · resets in ' + countdown(rollReset) : '')
        : 'no usage data'
    }

    var hasProv = !!(provData && provData.ok && Array.isArray(provData.providers) && provData.providers.length)

    if (!hasProv) {
      // v3 fallback: antigravity + opencode cards only
      var out = []
      var antConnected = !!(data && (data.account || (Array.isArray(buckets) && buckets.length)))
      out.push({
        id: 'antigravity',
        label: 'Antigravity (Google)',
        kind: 'oauth',
        connected: antConnected,
        detail: null,
        error: antErr,
        summary: antSummary()
      })
      if (usage) {
        out.push({
          id: 'opencode-go',
          label: 'OpenCode Go',
          kind: 'api-key',
          connected: usage.ok === true,
          detail: null,
          error: usage.ok === false ? (usage.error || 'opencode usage unavailable') : null,
          summary: ocSummary()
        })
      }
      return out
    }

    // v4: one card per provider
    var cards = []
    for (var i = 0; i < provData.providers.length; i++) {
      var p = provData.providers[i]
      if (!p || !p.id) continue
      var card = {
        id: p.id,
        label: p.label || p.id,
        kind: p.kind === 'api-key' || p.kind === 'import' ? p.kind : 'oauth',
        connected: !!p.connected,
        detail: p.detail && p.detail !== 'not connected' ? p.detail : null,
        error: null,
        summary: null
      }
      if (p.id === 'antigravity') {
        card.error = antErr
        card.summary = antSummary()
      } else if (p.id === 'opencode-go') {
        if (!usage) continue // defensive: nothing to show without usage data
        card.error = usage.ok === false ? (usage.error || 'opencode usage unavailable') : null
        card.summary = ocSummary()
      }
      cards.push(card)
    }
    return cards
  }

  // --- header chip ---------------------------------------------------------
  function QuotaChip() {
    var q = usePoll(function () { return apiGet('quota') }, 60 * 1000)
    var nowMs = useNow()
    var data = q.data
    var cfg = (data && data.config) || {}
    var buckets = getBuckets(data)
    var target = null
    if (cfg.primary_model) target = findBucketForModel(buckets, cfg.primary_model)
    if (!target) target = pickLowestBucket(buckets)
    var frac = target ? target.remaining : null
    var resetIn = target ? liveReset(target.reset_in_seconds, data && data.ts, nowMs) : null
    var threshold = cfg.low_threshold != null ? cfg.low_threshold : 0.1
    var dead = q.error && !data
    var broken = !dead && data && data.ok === false
    var warn = dead || broken || (frac != null && frac < threshold)
    var label
    var labelColor = ''
    if (dead) { label = '⚠ quota?'; labelColor = '#f87171' }
    else if (broken) { label = '⚠ quota'; labelColor = '#fbbf24' }
    else if (frac == null) { label = '◇ quota'; labelColor = '' }
    else {
      label = (warn ? '⚠ ' : '◇ ') + pct(frac) + ' · ' + countdown(resetIn)
      labelColor = toneColor(frac)
    }

    return React.createElement(
      'button',
      {
        className: cn('flex h-full items-center gap-1 px-2 font-mono text-xs', 'text-text-tertiary hover:text-text-primary'),
        style: labelColor ? { color: labelColor, textShadow: '0 0 12px ' + labelColor + '66' } : null,
        title: target
          ? target.display_name + ': ' + pct(frac) + ' left, resets in ' + countdown(resetIn) + ' — click to refresh'
          : 'CPA Quota — click to refresh',
        onClick: q.reload,
        type: 'button'
      },
      label
    )
  }

  // --- provider card -------------------------------------------------------
  function kindLabel(kind) {
    if (kind === 'api-key') return 'API key'
    if (kind === 'import') return 'Import'
    return 'OAuth'
  }

  function ProviderCard(props) {
    var p = props.p
    var open = props.open
    var onToggle = props.onToggle
    var onConnect = props.onConnect
    var connecting = props.connecting   // a connect flow is running for THIS provider
    var blocked = props.blocked         // another provider's flow is running
    var accent = brandColor(p.id)
    var dotColor = p.connected ? '#22c55e' : '#64748b'
    return React.createElement(
      'div',
      {
        className: cn('flex flex-col gap-2 rounded-md border p-3', open ? 'bg-card' : 'bg-background'),
        style: {
          borderLeft: '3px solid ' + accent,
          borderColor: open ? accent + '88' : undefined,
          boxShadow: open ? '0 4px 18px rgba(0,0,0,0.18)' : undefined
        }
      },
      React.createElement(
        'button',
        {
          type: 'button',
          onClick: onToggle,
          className: 'flex w-full cursor-pointer items-center justify-between gap-2 text-left'
        },
        React.createElement(
          'div',
          { className: 'flex min-w-0 flex-col gap-1' },
          React.createElement('span', { className: 'truncate text-sm font-medium text-text-primary' }, p.label),
          React.createElement(
            'span',
            { className: 'self-start rounded-md border px-1 text-text-tertiary', style: { color: accent, borderColor: accent + '55', fontSize: 10, lineHeight: '16px' } },
            kindLabel(p.kind)
          )
        ),
        React.createElement(
          'div',
          { className: 'flex shrink-0 items-center gap-2' },
          p.connected
            ? React.createElement(
                'span',
                { className: 'block truncate text-xs text-text-primary', style: { maxWidth: 150 } },
                React.createElement('span', { style: { color: dotColor } }, '●'),
                ' connected' + (p.detail ? ' · ' + p.detail : '')
              )
            : React.createElement(
                'span',
                { className: 'shrink-0 text-xs text-text-tertiary', style: { color: dotColor } },
                '○ not connected'
              ),
          React.createElement('span', { className: 'shrink-0 text-xs text-text-tertiary' }, open ? '▾' : '▸')
        )
      ),
      p.error
        ? React.createElement('div', { className: 'text-xs text-text-primary' }, '⚠ ' + p.error)
        : null,
      p.summary
        ? React.createElement('div', { className: 'font-mono text-xs text-text-secondary' }, p.summary)
        : null,
      !p.connected
        ? React.createElement(
            'button',
            {
              type: 'button',
              onClick: onConnect,
              disabled: connecting || blocked,
              style: connecting || blocked ? { opacity: 0.6, backgroundColor: accent, color: '#fff' } : { backgroundColor: accent, color: '#fff' },
              className: 'self-start rounded-md px-3 py-1 text-xs font-medium'
            },
            connecting ? 'Connecting…' : 'Connect'
          )
        : null
    )
  }

  // Generic detail box for providers without a dedicated quota view.
  function ProviderDetail(props) {
    var p = props.p
    if (!p) return null
    return React.createElement(
      'div',
      { className: 'rounded-md border p-3 text-xs text-text-tertiary' },
      p.connected
        ? React.createElement('span', { className: 'break-all' }, p.detail ? 'auth file: ' + p.detail : 'connected')
        : '○ not connected — press Connect to set up this subscription'
    )
  }

  // --- antigravity detail: bucket cards ------------------------------------
  function BucketCard(props) {
    var b = props.bucket
    var nowMs = props.nowMs
    var serverTs = props.serverTs
    var expanded = useState(false)
    var frac = b.remaining
    var resetIn = liveReset(b.reset_in_seconds, serverTs, nowMs)
    var barPct = frac == null ? 0 : Math.min(100, Math.max(0, frac * 100))
    var count = Array.isArray(b.models) ? b.models.length : (b.size || 0)
    var models = Array.isArray(b.models) ? b.models : []

    return React.createElement(
      'div',
      { className: 'flex flex-col gap-1 rounded-md border p-3', style: { borderLeft: '3px solid ' + barTone(frac).a } },
      React.createElement(
        'div',
        { className: 'flex items-center justify-between gap-2' },
        React.createElement('span', { className: 'truncate text-sm font-medium text-text-primary' }, b.display_name || 'Quota'),
        React.createElement(
          'div',
          { className: 'flex shrink-0 items-center gap-2 font-mono text-xs' },
          React.createElement('span', { className: 'font-semibold', style: { color: toneColor(frac) || undefined } }, pct(frac)),
          resetIn != null && frac != null
            ? React.createElement('span', { className: 'text-text-tertiary' }, '⏱ ' + countdown(resetIn))
            : null
        )
      ),
      frac == null
        ? null
        : React.createElement(
            'div',
            { className: 'w-full rounded-full bg-muted', style: { overflow: 'hidden', height: 8 } },
            React.createElement('div', { style: barStyle(frac) })
          ),
      count > 0
        ? React.createElement(
            'button',
            {
              type: 'button',
              onClick: function () { expanded[1](!expanded[0]) },
              className: 'cursor-pointer self-start text-xs text-text-tertiary hover:text-text-primary'
            },
            (expanded[0] ? '▾' : '▸') + ' ' + count + (count === 1 ? ' model' : ' models')
          )
        : null,
      expanded[0] && models.length
        ? React.createElement(
            'div',
            { className: 'whitespace-pre-wrap break-all text-xs text-text-tertiary' },
            models.join(', ')
          )
        : null
    )
  }

  function AntigravityDetail(props) {
    var data = props.data
    var nowMs = props.nowMs
    var buckets = getBuckets(data)
    var account = data ? data.account : null
    var tier = data && data.tier ? data.tier.name : null
    var err = data && data.ok === false ? (data.error || '') : ''
    return React.createElement(
      'div',
      { className: 'flex flex-col gap-2 rounded-md border p-3' },
      React.createElement(
        'div',
        { className: 'flex flex-wrap items-center gap-2 text-xs text-text-tertiary' },
        React.createElement('span', { className: 'truncate' }, account ? account : 'no account'),
        tier ? React.createElement('span', null, '· tier ' + tier) : null,
        data && data.token_expires_in != null && data.token_expires_in > 0
          ? React.createElement('span', null, '· token ' + countdown(data.token_expires_in))
          : null
      ),
      err
        ? React.createElement('div', { className: 'text-xs text-text-primary' }, '⚠ ' + err)
        : null,
      !buckets || !buckets.length
        ? React.createElement('div', { className: 'text-xs text-text-tertiary' }, 'no quota data')
        : React.createElement(
            'div',
            { className: 'flex flex-col gap-2' },
            buckets.map(function (b) {
              return React.createElement(BucketCard, {
                key: b.id || b.display_name,
                bucket: b,
                nowMs: nowMs,
                serverTs: data ? data.ts : null
              })
            })
          )
    )
  }

  // --- opencode detail: rolling / weekly / monthly -------------------------
  function UsageRow(props) {
    var label = props.label
    var w = props.w
    var nowMs = props.nowMs
    var used = typeof w.percent === 'number' ? Math.min(100, Math.max(0, w.percent)) : null
    var left = used != null ? Math.max(0, 100 - used) : null
    var resetIn = timeUntilIso(w.resetsAt, nowMs)
    var status = w.status
    var tone = usedTone(used)
    return React.createElement(
      'div',
      { className: 'flex flex-col gap-1 rounded-md border p-3', style: { borderLeft: '3px solid ' + tone.a } },
      React.createElement(
        'div',
        { className: 'flex items-center justify-between gap-2' },
        React.createElement(
          'div',
          { className: 'flex min-w-0 items-center gap-2' },
          React.createElement('span', { className: 'truncate text-sm font-medium text-text-primary' }, label),
          status
            ? React.createElement('span', { className: status === 'ok' ? 'shrink-0 text-xs text-text-tertiary' : 'shrink-0 text-xs text-text-primary' }, status)
            : null
        ),
        React.createElement(
          'div',
          { className: 'shrink-0 font-mono text-xs', style: { color: used == null ? undefined : tone.a } },
          used != null ? 'used ' + used + '% · left ' + left + '%' : '—'
        )
      ),
      used != null
        ? React.createElement(
            'div',
            { className: 'w-full rounded-full bg-muted', style: { overflow: 'hidden', height: 8 } },
            React.createElement('div', { style: (function () {
              var bs = barStyle((100 - used) / 100)
              bs.width = used + '%'
              return bs
            })() })
          )
        : null,
      resetIn != null
        ? React.createElement('div', { className: 'text-xs text-text-tertiary' }, 'resets in ' + countdown(resetIn))
        : null
    )
  }

  function OpenCodeDetail(props) {
    var usage = props.usage
    var nowMs = props.nowMs
    if (!usage) return null
    if (usage.ok === false) {
      return React.createElement(
        'div',
        { className: 'rounded-md border p-3 text-xs text-text-primary' },
        '⚠ ' + (usage.error || 'opencode usage unavailable')
      )
    }
    var specs = [
      { key: 'rolling', label: 'Rolling' },
      { key: 'weekly', label: 'Weekly' },
      { key: 'monthly', label: 'Monthly' }
    ]
    var rows = []
    for (var i = 0; i < specs.length; i++) {
      var w = usage[specs[i].key]
      if (!w || typeof w !== 'object') continue
      rows.push(React.createElement(UsageRow, { key: specs[i].key, label: specs[i].label, w: w, nowMs: nowMs }))
    }
    if (!rows.length) {
      return React.createElement('div', { className: 'rounded-md border p-3 text-xs text-text-tertiary' }, 'no usage windows')
    }
    return React.createElement('div', { className: 'flex flex-col gap-2' }, rows)
  }

  // --- universal connect modal ---------------------------------------------
  function ConnectModal(props) {
    var provider = props.provider
    var status = props.status
    var statusError = props.statusError
    var onClose = props.onClose
    var onSuccess = props.onSuccess
    var file = useState('')
    var busy = useState(false)
    var started = useState(false)
    var done = useState(null) // null | 'ok' | 'err' | 'cancel'
    var err = useState(null)
    var newFile = useState(null)
    var seenRunning = useRef(false) // observed this flow running in a poll
    var pollFails = useRef(0) // consecutive /connect/status fetch failures
    var outRef = useRef(null)
    var isImport = provider.kind === 'import'

    // Reset flow-scoped state whenever a new connect begins, so stale
    // results from a previous flow can never be claimed by this one.
    function resetFlow() {
      seenRunning.current = false
      pollFails.current = 0
      err[1](null)
      newFile[1](null)
      done[1](null)
    }

    // Non-import flows POST /connect {provider} right away — unless this
    // provider is already the one running (modal re-opened mid-flow).
    useEffect(function () {
      if (isImport) return
      var dead = false
      resetFlow()
      if (status && status.running) {
        if (status.provider === provider.id) {
          started[1](true)
          seenRunning.current = true
        } else if (status.provider) {
          // some other provider's flow is live (multi-tab) — don't start
          // a watcher for a flow that isn't ours
          err[1]('another login is running')
        }
        return function () { dead = true }
      }
      busy[1](true)
      apiPost('connect', { provider: provider.id })
        .then(function (r) {
          if (dead) return
          busy[1](false)
          if (r && r.ok && r.provider === provider.id) {
            started[1](true)
          } else if (r && r.ok && r.provider && r.provider !== provider.id) {
            // multi-tab race: a different provider grabbed the connect
            err[1]('another login is running')
          } else if (r && r.ok) {
            // old backend: response has no provider field — accept
            started[1](true)
          } else {
            err[1]((r && r.error) || 'failed to start login')
          }
        })
        .catch(function (e) {
          if (dead) return
          busy[1](false)
          err[1](String(e && e.message ? e.message : e))
        })
      return function () { dead = true }
    }, [provider.id, isImport])

    // Watch the shared /connect/status poll for completion. A status only
    // counts for this flow when it belongs to this provider (old backends
    // omit `provider` — accept those, but then require having observed the
    // flow running before treating a non-running status as completion).
    useEffect(function () {
      if (!started[0] || done[0]) return
      var s = status
      if (!s) return
      var mine = s.provider == null || s.provider === provider.id
      if (!mine) return
      if (s.running) {
        seenRunning.current = true
        return
      }
      // status has provider matching AND we started the flow: the backend
      // clears new_file/error when a new flow starts, so a matching status
      // observed after our POST is authoritative for this flow even when
      // the flow was too fast to observe running.
      if (s.provider === provider.id && started[0]) seenRunning.current = true
      if (!seenRunning.current) return
      if (s.new_file) {
        newFile[1](s.new_file)
        done[1]('ok')
        return
      }
      if (s.error === 'cancelled') {
        done[1]('cancel')
        return
      }
      if (s.error) {
        err[1](s.error)
        done[1]('err')
        return
      }
      err[1]('connect finished without a result')
      done[1]('err')
    }, [started[0], done[0], status, provider.id])

    // Consecutive /connect/status fetch failures: after ~4 in a row the
    // backend is effectively unreachable — surface an error instead of
    // waiting on a poll that will never deliver.
    useEffect(function () {
      if (!started[0] || done[0]) return
      if (statusError) {
        pollFails.current += 1
        if (pollFails.current >= 4) {
          err[1]('status polling failed — backend unreachable')
          done[1]('err')
        }
      } else {
        pollFails.current = 0
      }
    }, [started[0], done[0], statusError])

    // Auto-close shortly after success.
    useEffect(function () {
      if (done[0] !== 'ok') return
      var t = setTimeout(function () { onSuccess(newFile[0]) }, 1200)
      return function () { clearTimeout(t) }
    }, [done[0]])

    var output = status && typeof status.output === 'string' ? status.output : ''
    useEffect(function () {
      if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight
    }, [output])

    function doImport() {
      var f = file[0].trim()
      if (!f) { err[1]('enter a path to a .json auth file'); return }
      if (f.slice(-5) !== '.json') { err[1]('file must end with .json'); return }
      resetFlow()
      busy[1](true)
      err[1](null)
      apiPost('connect', { provider: provider.id, file: f })
        .then(function (r) {
          busy[1](false)
          if (r && r.ok && r.provider === provider.id) {
            started[1](true)
          } else if (r && r.ok && r.provider && r.provider !== provider.id) {
            err[1]('another login is running')
          } else if (r && r.ok) {
            started[1](true) // old backend: no provider field in response
          } else {
            err[1]((r && r.error) || 'failed to import auth file')
          }
        })
        .catch(function (e) { busy[1](false); err[1](String(e && e.message ? e.message : e)) })
    }

    function cancel() {
      done[1]('cancel')
      apiPost('connect/cancel').catch(function () {})
    }

    var s = status
    var running = !!(s && s.running)
    // auth_url from the backend is only rendered as a link when it is a
    // real http(s) URL; anything else (javascript:, data:, …) is shown as
    // plain text so it can never execute or navigate.
    var authUrl = s && s.auth_url ? s.auth_url : null
    var safeAuthUrl = isSafeUrl(authUrl) ? authUrl : null

    return React.createElement(
      'div',
      {
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 50,
          background: 'rgba(0, 0, 0, 0.55)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16
        }
      },
      React.createElement(
        'div',
        {
          className: 'flex flex-col gap-3 rounded-md border bg-card p-4',
          style: {
            width: 520,
            maxWidth: '92vw',
            maxHeight: '86vh',
            boxShadow: '0 24px 70px rgba(0,0,0,0.5)',
            borderTop: '3px solid ' + brandColor(provider.id)
          }
        },
        React.createElement(
          'div',
          { className: 'flex items-center justify-between gap-2' },
          React.createElement(
            'span',
            { className: 'truncate text-sm font-semibold text-text-primary' },
            React.createElement('span', { style: { color: brandColor(provider.id) } }, '● '),
            'Connect ' + provider.label
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: onClose,
              className: 'shrink-0 cursor-pointer rounded-md border px-2 py-1 text-xs text-text-secondary hover:text-text-primary'
            },
            '✕'
          )
        ),
        isImport
          ? React.createElement(
              'div',
              { className: 'flex flex-col gap-2' },
              React.createElement('span', { className: 'text-xs text-text-secondary' }, 'Path to a service-account JSON auth file:'),
              React.createElement(
                'div',
                { className: 'flex items-center gap-2' },
                React.createElement('input', {
                  className: 'min-w-0 rounded-md border bg-background px-2 py-1 font-mono text-xs text-text-primary',
                  style: { flex: 1 },
                  type: 'text',
                  placeholder: '/abs/path/vertex-auth.json',
                  value: file[0],
                  onChange: function (e) { file[1](e.target.value) }
                }),
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    onClick: doImport,
                    disabled: busy[0] || running,
                    style: { backgroundColor: brandColor(provider.id), color: '#fff', opacity: busy[0] || running ? 0.6 : 1 },
                    className: 'shrink-0 rounded-md px-3 py-1 text-xs font-medium'
                  },
                  busy[0] ? 'Importing…' : 'Import'
                )
              ),
              React.createElement('div', { className: 'text-xs text-text-tertiary' }, 'must be a .json file')
            )
          : null,
        busy[0]
          ? React.createElement('div', { className: 'text-xs text-text-tertiary' }, 'starting…')
          : null,
        authUrl
          ? React.createElement(
              'div',
              { className: 'flex flex-col gap-1' },
              React.createElement('span', { className: 'text-xs text-text-secondary' }, 'Open this URL and sign in (opens in a new tab):'),
              safeAuthUrl
                ? React.createElement(
                    'a',
                    {
                      className: 'break-all rounded-md border bg-background px-2 py-1 text-xs text-text-primary',
                      style: { borderLeft: '3px solid ' + brandColor(provider.id) },
                      href: safeAuthUrl,
                      target: '_blank',
                      rel: 'noreferrer'
                    },
                    safeAuthUrl
                  )
                : React.createElement(
                    'div',
                    { className: 'truncate rounded-md border bg-background px-2 py-1 text-xs text-text-tertiary', title: authUrl },
                    authUrl
                  )
            )
          : null,
        React.createElement(
          'div',
          {
            ref: outRef,
            className: 'overflow-y-auto whitespace-pre-wrap break-all rounded-md border bg-background p-2 font-mono text-xs text-text-secondary',
            style: { maxHeight: 120 }
          },
          output || '—'
        ),
        done[0] === 'ok'
          ? React.createElement('div', { className: 'text-xs text-text-primary' }, '✓ connected: ' + newFile[0])
          : null,
        done[0] === 'cancel'
          ? React.createElement('div', { className: 'text-xs text-text-secondary' }, 'cancelled')
          : null,
        err[0] && done[0] !== 'ok'
          ? React.createElement('div', { className: 'text-xs text-text-primary' }, err[0])
          : null,
        React.createElement(
          'div',
          { className: 'flex items-center justify-between gap-2' },
          running && !done[0]
            ? React.createElement(
                'button',
                {
                  type: 'button',
                  onClick: cancel,
                  className: 'rounded-md border px-3 py-1 text-xs text-text-secondary hover:text-text-primary'
                },
                'Cancel'
              )
            : React.createElement(
                'button',
                {
                  type: 'button',
                  onClick: onClose,
                  className: 'rounded-md border px-3 py-1 text-xs text-text-secondary hover:text-text-primary'
                },
                'Close'
              )
        )
      )
    )
  }

  // --- settings popover ----------------------------------------------------
  function SettingsPopover(props) {
    var cfg = props.cfg || {}
    var onSaved = props.onSaved
    var refresh = useState(String(cfg.refresh_interval_seconds || 60))
    var threshold = useState(String(cfg.low_threshold != null ? cfg.low_threshold : 0.1))
    var hosts = useState((cfg.hosts || []).join(', '))
    var authDir = useState(cfg.auth_dir || '')
    var busy = useState(false)
    var msg = useState(null)

    function save() {
      busy[1](true)
      msg[1](null)
      var payload = {
        refresh_interval_seconds: parseInt(refresh[0], 10) || 60,
        low_threshold: parseFloat(threshold[0]),
        hosts: hosts[0].split(',').map(function (s) { return s.trim() }).filter(Boolean),
        auth_dir: authDir[0].trim() || null
      }
      apiPut('config', payload)
        .then(function (r) {
          busy[1](false)
          if (r && r.ok) {
            msg[1]('saved ✓')
            onSaved()
          } else {
            msg[1]('save failed: ' + ((r && r.error) || 'unknown'))
          }
        })
        .catch(function (e) { busy[1](false); msg[1]('save failed: ' + (e && e.message ? e.message : e)) })
    }

    function field(label, node) {
      return React.createElement(
        'div',
        { className: 'flex flex-col gap-1' },
        React.createElement('label', { className: 'text-xs text-text-secondary' }, label),
        node
      )
    }

    return React.createElement(
      'div',
      { className: 'flex flex-col gap-3 rounded-md border p-3' },
      React.createElement('div', { className: 'text-sm font-semibold text-text-primary' }, 'Settings'),
      React.createElement(
        'div',
        { className: 'flex flex-wrap items-center gap-3' },
        field('Refresh interval (s)', React.createElement('input', {
          className: 'rounded-md border bg-card px-2 py-1 text-xs text-text-primary',
          style: { width: 80 },
          type: 'number',
          min: 15,
          max: 3600,
          value: refresh[0],
          onChange: function (e) { refresh[1](e.target.value) }
        })),
        field('Alert below (0–1)', React.createElement('input', {
          className: 'rounded-md border bg-card px-2 py-1 text-xs text-text-primary',
          style: { width: 80 },
          type: 'number',
          min: 0,
          max: 1,
          step: 0.05,
          value: threshold[0],
          onChange: function (e) { threshold[1](e.target.value) }
        }))
      ),
      React.createElement(
        'details',
        { className: 'text-xs text-text-secondary' },
        React.createElement('summary', { className: 'cursor-pointer' }, 'Advanced'),
        React.createElement(
          'div',
          { className: 'flex flex-col gap-2', style: { marginTop: 8 } },
          field('Hosts (quota fetch, comma-separated)', React.createElement('input', {
            className: 'rounded-md border bg-card px-2 py-1 text-xs text-text-primary',
            value: hosts[0],
            onChange: function (e) { hosts[1](e.target.value) }
          })),
          field('Auth dir', React.createElement('input', {
            className: 'rounded-md border bg-card px-2 py-1 text-xs text-text-primary',
            value: authDir[0],
            placeholder: 'default: ~/.cli-proxy-api',
            onChange: function (e) { authDir[1](e.target.value) }
          }))
        )
      ),
      React.createElement(
        'div',
        { className: 'flex items-center gap-3' },
        React.createElement(
          'button',
          {
            className: 'rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground',
            type: 'button',
            onClick: save,
            disabled: busy[0],
            style: busy[0] ? { opacity: 0.6 } : null
          },
          busy[0] ? 'Saving…' : 'Save'
        ),
        msg[0] ? React.createElement('span', { className: 'text-xs text-text-secondary' }, msg[0]) : null
      )
    )
  }

  // --- main page -----------------------------------------------------------
  function SubscriptionsPage() {
    var intervalMs = useState(60 * 1000)
    var q = usePoll(function () { return apiGet('quota') }, intervalMs[0])
    var prov = usePoll(function () { return apiGet('providers') }, 60 * 1000)
    var cs = usePoll(function () { return apiGet('connect/status') }, CONNECT_POLL_MS)
    var nowMs = useNow()
    var data = q.data
    var cfg = (data && data.config) || {}
    var openProvider = useState('antigravity')
    var connectTarget = useState(null)
    var showSettings = useState(false)
    var notice = useState(null)

    useEffect(function () {
      if (cfg.refresh_interval_seconds) {
        intervalMs[1](Math.max(15, cfg.refresh_interval_seconds) * 1000)
      }
    }, [cfg.refresh_interval_seconds])

    function reloadAll() {
      q.reload()
      prov.reload()
      cs.reload()
    }

    function toggleProvider(id) {
      openProvider[1](openProvider[0] === id ? null : id)
    }

    var providers = buildProviderList(data, prov.data, nowMs)
    var csData = cs.data
    var anyRunning = !!(csData && csData.running)
    var runningProvider = anyRunning && csData.provider ? csData.provider : null
    var openDetailP = null
    for (var i = 0; i < providers.length; i++) {
      if (providers[i].id === openProvider[0] && providers[i].id !== 'antigravity' && providers[i].id !== 'opencode-go') {
        openDetailP = providers[i]
      }
    }

    return React.createElement(
      'div',
      { className: 'flex h-full flex-col gap-3 overflow-y-auto p-4' },
      React.createElement(
        'div',
        { className: 'flex flex-wrap items-center gap-2' },
        React.createElement(
          'div',
          { className: 'flex min-w-0 flex-col', style: { gap: 2 } },
          React.createElement(
            'span',
            { className: 'text-xl font-semibold tracking-wide text-text-primary' },
            React.createElement('span', { style: { color: '#4285F4' } }, '◆ '),
            'AI Subscriptions'
          ),
          React.createElement('span', { className: 'text-xs text-text-tertiary' }, 'live quota for your CLIProxyAPI subscriptions')
        ),
        React.createElement('span', { className: 'ml-auto' }),
        React.createElement(
          'button',
          {
            className: 'rounded-md border px-2 py-1 text-base leading-none text-text-secondary hover:text-text-primary',
            type: 'button',
            title: 'Settings',
            onClick: function () { showSettings[1](!showSettings[0]) }
          },
          '⚙'
        ),
        React.createElement(
          'button',
          {
            className: 'rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground',
            type: 'button',
            onClick: reloadAll
          },
          'Refresh'
        )
      ),
      showSettings[0]
        ? React.createElement(SettingsPopover, {
            cfg: cfg,
            onSaved: function () { reloadAll(); notice[1]('settings saved') }
          })
        : null,
      React.createElement(
        'div',
        { className: providers.length > 1 ? 'grid grid-cols-2 content-start gap-3' : 'grid grid-cols-1 content-start gap-3' },
        providers.map(function (p) {
          return React.createElement(ProviderCard, {
            key: p.id,
            p: p,
            open: openProvider[0] === p.id,
            onToggle: function () { toggleProvider(p.id) },
            onConnect: function () { connectTarget[1](p) },
            connecting: anyRunning && runningProvider === p.id,
            blocked: anyRunning && runningProvider !== p.id
          })
        })
      ),
      openProvider[0] === 'antigravity'
        ? React.createElement(AntigravityDetail, { data: data, nowMs: nowMs })
        : null,
      openProvider[0] === 'opencode-go' && data && data.opencode_usage
        ? React.createElement(OpenCodeDetail, { usage: data.opencode_usage, nowMs: nowMs })
        : null,
      openDetailP
        ? React.createElement(ProviderDetail, { p: openDetailP })
        : null,
      connectTarget[0]
        ? React.createElement(ConnectModal, {
            provider: connectTarget[0],
            status: csData,
            statusError: cs.error,
            onClose: function () { connectTarget[1](null) },
            onSuccess: function (nf) {
              connectTarget[1](null)
              notice[1](nf ? '✓ connected: ' + nf : 'connected ✓')
              reloadAll()
            }
          })
        : null,
      notice[0] ? React.createElement('div', { className: 'text-xs text-text-secondary' }, notice[0]) : null,
      q.error && !data
        ? React.createElement(
            'div',
            { className: 'rounded-md border p-3 text-sm text-text-secondary' },
            '⚠ ' + q.error + ' — is cpa-quota enabled in plugins.enabled?'
          )
        : null,
      !data && !q.error
        ? React.createElement('div', { className: 'text-sm text-text-tertiary' }, 'loading quota…')
        : null,
      React.createElement(
        'div',
        { className: 'border-t py-1 text-xs text-text-tertiary' },
        'remaining = fraction of current quota window · buckets group models sharing one window · click a card for details · Connect starts the subscription login'
      )
    )
  }

  // --- register ------------------------------------------------------------
  try {
    window.__HERMES_PLUGINS__.register(NAME, SubscriptionsPage)
    window.__HERMES_PLUGINS__.registerSlot(NAME, 'header-right', QuotaChip)
  } catch (err) {
    console.warn('[cpa-quota] registration failed:', err)
  }
})()
