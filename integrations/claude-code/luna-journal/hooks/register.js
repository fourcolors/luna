// luna-journal: posts a short end-of-session journal to Luna.
//
// Nothing slow runs while the user waits. No hook awaits a subprocess: git,
// hostname and the Keychain lookup run in zero-delay background timers.
// session.end only queues the entry in $.store (it shares a 1.5s budget with
// every other mod); the model call and the POST happen 15s into the NEXT
// session, from a timer.
import {
  ANSWER_CAP,
  MAX_FILES,
  MAX_TURNS,
  SYSTEM,
  buildBody,
  buildPrompt,
  clampSummary,
  cleanFiles,
  clientFromSurface,
  fallbackSummary,
  makeEntryId,
  porcelainPaths,
  redact,
  redactPath,
} from './lib.js'

const FLUSH_DELAY_MS = 15000
const MAX_ATTEMPTS = 5
const STALE_SESS_MS = 6 * 3600e3
const PENDING_TTL_MS = 7 * 86400e3
// $.store holds at most 4 MiB per mod; the queue stays well inside that.
const MAX_PENDING = 50
const MAX_PENDING_BYTES = 1024 * 1024
const LEASE_MS = 120e3
const GIT_TIMEOUT_MS = 2000
const LOG_KEEP = 50

const enabled = (options) => options.enabled !== false

// Configuration failures: the next session will fail the same way, and the
// entry should survive until the setup is fixed rather than burn an attempt.
const CONFIG_STATUSES = [401, 403, 503]

// $.store has no transactions, so every read-modify-write of one key runs
// through this chain. It covers concurrent hooks in this process (parallel
// tool calls, subagents); separate Claude Code processes can still race, which
// is why entry ids are minted once per segment and never from the clock at
// promotion time.
const chains = new Map()
function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => {})
  chains.set(key, tail)
  tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key)
  })
  return run
}

// Secret values learned in this process (the Keychain token), held in memory
// only, so turns captured later are scrubbed of them before they are stored.
const knownSecrets = new Set()

async function secretsFor($, options) {
  const out = [...knownSecrets]
  if (options.luna_token) out.push(options.luna_token)
  try {
    const env = await $.env.get('LUNA_JOURNAL_TOKEN')
    if (env) out.push(env)
  } catch {}
  return out
}

// Local-only failure log. `what` is always one of the fixed category literals
// in this file and `status` an HTTP status code: never an exception message or
// a response body, which can carry a header or token.
async function log($, what, status) {
  try {
    const l = (await $.store.get('log')) || []
    const at = new Date(await $.clock.now()).toISOString()
    const row = { at, what }
    if (Number.isInteger(status)) row.status = status
    l.push(row)
    await $.store.set('log', l.slice(-LOG_KEEP))
  } catch {}
}

async function git($, cwd, args) {
  try {
    const r = await $.process.run(['git', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS })
    return r.exitCode === 0 ? String(r.stdout ?? '').trim() : ''
  } catch {
    return ''
  }
}

async function hostName($) {
  try {
    const r = await $.process.run(['hostname', '-s'], { timeoutMs: GIT_TIMEOUT_MS })
    if (r.exitCode === 0 && String(r.stdout ?? '').trim()) return String(r.stdout).trim()
  } catch {}
  return (await $.env.get('HOST')) || 'mac'
}

async function resolveToken($, options) {
  if (options.luna_token) return options.luna_token
  try {
    const r = await $.process.run(['security', 'find-generic-password', '-s', 'luna-journal', '-w'], {
      timeoutMs: 3000,
    })
    if (r.exitCode === 0 && String(r.stdout ?? '').trim()) {
      const t = String(r.stdout).trim()
      knownSecrets.add(t)
      return t
    }
  } catch {}
  return (await $.env.get('LUNA_JOURNAL_TOKEN')) || null
}

/** The segment's idempotency key: minted with the accumulator, reused forever. */
const segmentId = (acc) => acc.entryId || makeEntryId(acc.sid, acc.startedAt || 0)

const basename = (p) => String(p || '').replace(/\/+$/, '').split('/').pop()

// No subprocess here: the hook that calls this must return at once. Git and
// host details are filled in by enrich() from a background timer.
async function newAccumulator($, sid, cwd, surface) {
  const now = await $.clock.now()
  return {
    sid,
    entryId: makeEntryId(sid, now),
    cwd,
    repo: basename(cwd) || 'unknown',
    branch: '',
    startSha: '',
    headSha: '',
    startedAt: now,
    lastActivityAt: now,
    turns: [],
    files: [],
    gitFiles: [],
    host: '',
    client: clientFromSurface(surface),
    enriched: false,
  }
}

// The session's own working tree. $.session.repo().root is the MAIN tree for
// a worktree, so it is only used for the display name.
async function enrich($, options, key) {
  const acc = await $.store.get(key)
  if (!acc) return
  const root = acc.enriched ? acc.cwd : (await git($, acc.cwd, ['rev-parse', '--show-toplevel'])) || acc.cwd
  let repo = null
  try {
    repo = await $.session.repo()
  } catch {}
  const [branch, startSha, host] = await Promise.all([
    git($, root, ['branch', '--show-current']),
    git($, root, ['rev-parse', 'HEAD']),
    hostName($),
    resolveToken($, options).catch(() => null),
  ])
  let clientVersion
  try {
    clientVersion = (await $.session.version())?.version
  } catch {}
  const exact = await secretsFor($, options)
  await withLock(key, async () => {
    const cur = await $.store.get(key)
    if (!cur) return
    const m = { ...cur, enriched: true }
    if (!cur.enriched) {
      m.cwd = root
      m.repo = basename(repo?.root) || basename(root) || cur.repo
    }
    const found = { branch, startSha, headSha: startSha, host, clientVersion }
    for (const [f, v] of Object.entries(found)) if (!cur[f] && v) m[f] = v
    // Turns and paths captured before the Keychain token was known.
    m.turns = (cur.turns || []).map((t) => ({ ...t, a: redact(t.a, exact) }))
    m.files = (cur.files || []).map((f) => redactPath(f, exact))
    await $.store.set(key, m)
  })
}

// Branch, HEAD and the files that differ from the session's start commit,
// refreshed after each turn so the flush never has to look at the repo again.
async function snapshotGit($, key) {
  const acc = await $.store.get(key)
  if (!acc || !acc.enriched) return
  const at = await $.clock.now()
  const [branch, head, diff, status] = await Promise.all([
    git($, acc.cwd, ['branch', '--show-current']),
    git($, acc.cwd, ['rev-parse', 'HEAD']),
    acc.startSha ? git($, acc.cwd, ['diff', '--name-only', acc.startSha]) : Promise.resolve(''),
    git($, acc.cwd, ['status', '--porcelain']),
  ])
  const snap = {
    gitFiles: [...diff.split('\n'), ...porcelainPaths(status)].filter(Boolean).slice(0, MAX_FILES),
    snapAt: at,
  }
  if (branch) snap.branch = branch
  if (head) snap.headSha = head
  await withLock(key, async () => {
    const cur = await $.store.get(key)
    // An older snapshot finishing late never overwrites a newer one.
    if (cur && (cur.snapAt || 0) <= at) await $.store.set(key, { ...cur, ...snap })
  })
}

// Runs outside any event, so a slow git never holds up the user.
function inBackground($, options, sid, { snapshot }) {
  const key = 'sess:' + sid
  $.clock.after(0, async () => {
    try {
      const acc = await $.store.get(key)
      if (!acc) return
      if (!acc.enriched) await enrich($, options, key)
      if (snapshot) await snapshotGit($, key)
    } catch {
      await log($, 'background')
    }
  })
}

// session.start does not fire again after /clear or /resume, so the first
// turn of the new session creates its accumulator here. Call under withLock.
// Answers [acc, created].
async function loadAccumulator($, sid) {
  const acc = await $.store.get('sess:' + sid)
  if (acc) return [acc, false]
  const cwd = await $.session.cwd()
  const fresh = await newAccumulator($, sid, cwd, null)
  await $.store.set('sess:' + sid, fresh)
  return [fresh, true]
}

async function promoteStale($, now) {
  for (const k of await $.store.keys()) {
    if (!k.startsWith('sess:')) continue
    await withLock(k, async () => {
      const s = await $.store.get(k)
      if (!s || now - (s.lastActivityAt || 0) <= STALE_SESS_MS) return
      if ((s.turns?.length || 0) + (s.files?.length || 0) > 0) await queue($, s, s.lastActivityAt, 'crash-recovered')
      await $.store.delete(k)
    })
  }
}

// Writes the segment's pending entry unless one is already queued: a retried
// promotion, or a second process ending the same segment, lands on the same
// key and keeps the first copy with its attempts and cached summary.
async function queue($, acc, endedAt, reason) {
  const entryId = segmentId(acc)
  const pk = 'pending:' + entryId
  await withLock(pk, async () => {
    if (await $.store.get(pk)) return
    await $.store.set(pk, { ...acc, entryId, endedAt, reason, attempts: 0 })
  })
}

// Drops expired and exhausted entries, then the oldest beyond the count and
// byte limits. Runs on every flush whether or not Luna is configured, so a
// long outage or a missing token cannot fill the store.
async function prune($, now) {
  const live = []
  for (const k of await $.store.keys()) {
    if (!k.startsWith('pending:')) continue
    await withLock(k, async () => {
      const p = await $.store.get(k)
      if (!p) return
      if ((p.attempts || 0) >= MAX_ATTEMPTS || now - (p.endedAt || 0) > PENDING_TTL_MS) {
        await $.store.delete(k)
        await log($, 'drop-expired')
        return
      }
      live.push({ k, endedAt: p.endedAt || 0, bytes: JSON.stringify(p).length })
    })
  }
  live.sort((a, b) => b.endedAt - a.endedAt)
  let bytes = 0
  for (const [i, e] of live.entries()) {
    bytes += e.bytes
    if (i < MAX_PENDING && bytes <= MAX_PENDING_BYTES) continue
    await withLock(e.k, () => $.store.delete(e.k))
    await log($, 'drop-overflow')
  }
}

async function summarize($, options, p, files, exact) {
  const model = options.model || 'haiku'
  try {
    const r = await $.model.complete({
      model,
      system: SYSTEM,
      prompt: buildPrompt(p, files, exact),
      maxTokens: 300,
      timeoutMs: 20000,
    })
    // 2.1.277 typed this as a bare string; 2.1.291 returns { isAnswered, text }.
    const text = typeof r === 'string' ? r : r?.isAnswered ? r.text : ''
    const summary = clampSummary(text, exact)
    if (summary) return { summary, model }
    await log($, 'model-empty')
  } catch {
    await log($, 'model-error')
  }
  return { summary: clampSummary(fallbackSummary(p, files), exact), model: 'fallback' }
}

// Takes the lease, or answers null when the entry is gone or leased.
async function lease($, k, now) {
  return withLock(k, async () => {
    const p = await $.store.get(k)
    if (!p || (p.leaseUntil || 0) > now || (p.attempts || 0) >= MAX_ATTEMPTS) return null
    const attempts = (p.attempts || 0) + 1
    await $.store.set(k, { ...p, attempts, leaseUntil: now + LEASE_MS })
    return { p, attempts }
  })
}

// Returns 'config' when the server refused the setup, so the caller stops.
async function flushOne($, options, k, url, token) {
  const now = await $.clock.now()
  const held = await lease($, k, now)
  if (!held) return
  const { p, attempts } = held
  const exact = [token, ...(await secretsFor($, options))]
  const files = cleanFiles([...(p.files || []), ...(p.gitFiles || [])], p.cwd, exact)
  let summary = p.summary
  let model = p.summaryModel
  if (!summary) {
    const s = await summarize($, options, p, files, exact)
    summary = s.summary
    model = s.model
    // Cached so a retry neither pays for nor changes the summary.
    await $.store.set(k, { ...p, attempts, leaseUntil: now + LEASE_MS, summary, summaryModel: model })
  }
  const res = await $.http.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify(buildBody(p, files, summary, model, exact)),
  })
  if (res.ok || [400, 413, 422].includes(res.status)) {
    // Accepted, or permanently malformed: retrying would not help.
    await $.store.delete(k)
    if (!res.ok) await log($, 'rejected', res.status)
  } else if (CONFIG_STATUSES.includes(res.status)) {
    await log($, 'config', res.status)
    const cur = await $.store.get(k)
    if (cur) await $.store.set(k, { ...cur, attempts: Math.max(0, attempts - 1), leaseUntil: 0 })
    return 'config'
  } else {
    await log($, 'post', res.status)
    const cur = await $.store.get(k)
    if (cur) await $.store.set(k, { ...cur, leaseUntil: 0 })
  }
}

async function flushAll($, options) {
  if (!enabled(options)) return
  const now = await $.clock.now()
  await promoteStale($, now)
  await prune($, now)
  const keys = (await $.store.keys()).filter((k) => k.startsWith('pending:'))
  if (keys.length === 0) return
  const url = options.luna_url || (await $.env.get('LUNA_JOURNAL_URL'))
  const token = await resolveToken($, options)
  if (!url || !token) {
    await log($, 'config-missing')
    return
  }
  for (const k of keys) {
    try {
      if ((await flushOne($, options, k, url, token)) === 'config') break
    } catch {
      // Network refused or timed out: keep the entry for the next session.
      await log($, 'network')
      try {
        const cur = await $.store.get(k)
        if (cur) await $.store.set(k, { ...cur, leaseUntil: 0 })
      } catch {}
    }
  }
}

// Notes one edited file in the session's accumulator. May throw: the
// tool.call hook's .catch is what keeps a failure here off the tool call.
async function recordEdit($, options, e, r) {
  const raw = e.file_path || e.notebook_path
  if (!raw || r?.deny || r?.isError) return
  const path = redactPath(raw, await secretsFor($, options))
  const sid = await $.session.id()
  const created = await withLock('sess:' + sid, async () => {
    const [acc, isNew] = await loadAccumulator($, sid)
    if (!acc.files.includes(path) && acc.files.length < MAX_FILES) {
      acc.files.push(path)
      acc.lastActivityAt = await $.clock.now()
      await $.store.set('sess:' + sid, acc)
    }
    return isNew
  })
  if (created) inBackground($, options, sid, { snapshot: false })
}

export function register(on, options = {}) {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    if (!enabled(options)) return r
    try {
      const sid = await $.session.id()
      const key = 'sess:' + sid
      const cwd = e.cwd || (await $.session.cwd())
      await withLock(key, async () => {
        const cur = await $.store.get(key)
        if (!cur) return $.store.set(key, await newAccumulator($, sid, cwd, e.surface))
        // A reload of the mod fires session.start again mid-session: keep
        // what was recorded and only fill in what the first pass lacked.
        if (e.surface && (!cur.client || cur.client === 'claude-code')) {
          await $.store.set(key, { ...cur, client: clientFromSurface(e.surface) })
        }
      })
      inBackground($, options, sid, { snapshot: false })
    } catch {
      await log($, 'start')
    }
    $.clock.after(FLUSH_DELAY_MS, () => flushAll($, options).catch(() => {}))
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!enabled(options) || e.agentId || !e.answer) return r
    try {
      const sid = await $.session.id()
      const key = 'sess:' + sid
      const exact = await secretsFor($, options)
      await withLock(key, async () => {
        const [a] = await loadAccumulator($, sid)
        a.turns.push({ a: redact(e.answer, exact).slice(0, ANSWER_CAP) })
        if (a.turns.length > MAX_TURNS) a.turns.splice(0, a.turns.length - MAX_TURNS)
        a.lastActivityAt = await $.clock.now()
        await $.store.set(key, a)
      })
      inBackground($, options, sid, { snapshot: true })
    } catch {
      await log($, 'turn')
    }
    return r
  })

  // Only observes: the call and its result pass through untouched. Bookkeeping
  // runs after next() settled, and a failure there (a throw or an overrun) is
  // answered by the .catch below, which fails OPEN: next(e) in a .catch
  // handler replays what the hook's own next() settled to, so the tool runs
  // once and its result stands exactly as Claude Code produced it.
  on('tool.call', { tool: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] }, async ($, e, next) => {
    const r = await next(e)
    if (enabled(options)) await recordEdit($, options, e, r)
    return r
  }).catch(async ($, e, next) => {
    const r = await next(e)
    await log($, 'tool')
    return r
  })

  on('session.end', async ($, e, next) => {
    try {
      const key = 'sess:' + e.sessionId
      await withLock(key, async () => {
        const acc = await $.store.get(key)
        if (acc && (acc.turns.length || acc.files.length)) await queue($, acc, await $.clock.now(), e.reason)
        if (acc) await $.store.delete(key)
      })
    } catch {}
    return next(e)
  })
}
