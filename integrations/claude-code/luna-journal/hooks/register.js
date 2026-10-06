// luna-journal: posts a short end-of-session journal to Luna.
//
// Nothing slow runs while the user waits. session.end only queues the entry
// in $.store (it shares a 1.5s budget with every other mod); the model call
// and the POST happen 15s into the NEXT session, from a timer.
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
} from './lib.js'

const FLUSH_DELAY_MS = 15000
const MAX_ATTEMPTS = 5
const STALE_SESS_MS = 6 * 3600e3
const PENDING_TTL_MS = 7 * 86400e3
const LEASE_MS = 120e3
const GIT_TIMEOUT_MS = 2000
const LOG_KEEP = 50

const enabled = (options) => options.enabled !== false

// Local-only failure log: status codes and short messages, never the token.
async function log($, what, err) {
  try {
    const l = (await $.store.get('log')) || []
    const at = new Date(await $.clock.now()).toISOString()
    l.push({ at, what, err: String(err?.message ?? err ?? '').slice(0, 200) })
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
    if (r.exitCode === 0 && String(r.stdout ?? '').trim()) return String(r.stdout).trim()
  } catch {}
  return (await $.env.get('LUNA_JOURNAL_TOKEN')) || null
}

// Branch, HEAD and the files that differ from the session's start commit,
// refreshed after each turn so the flush never has to look at the repo again.
async function snapshotGit($, acc) {
  const [branch, head, diff, status] = await Promise.all([
    git($, acc.cwd, ['branch', '--show-current']),
    git($, acc.cwd, ['rev-parse', 'HEAD']),
    acc.startSha ? git($, acc.cwd, ['diff', '--name-only', acc.startSha]) : Promise.resolve(''),
    git($, acc.cwd, ['status', '--porcelain']),
  ])
  if (branch) acc.branch = branch
  if (head) acc.headSha = head
  acc.gitFiles = [...diff.split('\n'), ...porcelainPaths(status)].filter(Boolean).slice(0, MAX_FILES)
}

async function newAccumulator($, sid, cwd, surface) {
  const repo = await $.session.repo()
  const root = repo?.root || cwd
  const [branch, startSha, host] = await Promise.all([
    git($, root, ['branch', '--show-current']),
    git($, root, ['rev-parse', 'HEAD']),
    hostName($),
  ])
  let clientVersion
  try {
    clientVersion = (await $.session.version())?.version
  } catch {}
  const now = await $.clock.now()
  return {
    sid,
    cwd: root,
    repo: repo?.name || root.split('/').pop() || 'unknown',
    branch,
    startSha,
    headSha: startSha,
    startedAt: now,
    lastActivityAt: now,
    turns: [],
    files: [],
    gitFiles: [],
    host,
    client: clientFromSurface(surface),
    clientVersion,
  }
}

// session.start does not fire again after /clear or /resume, so the first
// turn of the new session creates its accumulator here.
async function loadAccumulator($) {
  const sid = await $.session.id()
  const acc = await $.store.get('sess:' + sid)
  if (acc) return acc
  const cwd = await $.session.cwd()
  const fresh = await newAccumulator($, sid, cwd, null)
  await $.store.set('sess:' + sid, fresh)
  return fresh
}

async function promoteStale($, now) {
  for (const k of await $.store.keys()) {
    if (!k.startsWith('sess:')) continue
    const s = await $.store.get(k)
    if (!s || now - (s.lastActivityAt || 0) <= STALE_SESS_MS) continue
    if ((s.turns?.length || 0) + (s.files?.length || 0) > 0) {
      const entryId = makeEntryId(s.sid, now, 'cr')
      await $.store.set('pending:' + entryId, {
        ...s,
        entryId,
        endedAt: s.lastActivityAt,
        reason: 'crash-recovered',
        attempts: 0,
      })
    }
    await $.store.delete(k)
  }
}

async function summarize($, options, p, files) {
  const model = options.model || 'haiku'
  try {
    const r = await $.model.complete({
      model,
      system: SYSTEM,
      prompt: buildPrompt(p, files),
      maxTokens: 300,
      timeoutMs: 20000,
    })
    // 2.1.277 typed this as a bare string; 2.1.291 returns { isAnswered, text }.
    const text = typeof r === 'string' ? r : r?.isAnswered ? r.text : ''
    const summary = clampSummary(text)
    if (summary) return { summary, model }
    await log($, 'model', r?.reason || 'empty reply')
  } catch (err) {
    await log($, 'model', err)
  }
  return { summary: clampSummary(fallbackSummary(p, files)), model: 'fallback' }
}

async function flushOne($, options, k, url, token) {
  const now = await $.clock.now()
  const p = await $.store.get(k)
  if (!p || (p.leaseUntil || 0) > now) return
  if ((p.attempts || 0) >= MAX_ATTEMPTS || now - (p.endedAt || 0) > PENDING_TTL_MS) {
    await $.store.delete(k)
    await log($, 'drop ' + p.entryId, 'attempts or age exhausted')
    return
  }
  const attempts = (p.attempts || 0) + 1
  await $.store.set(k, { ...p, attempts, leaseUntil: now + LEASE_MS })
  const files = cleanFiles([...(p.files || []), ...(p.gitFiles || [])], p.cwd)
  let summary = p.summary
  let model = p.summaryModel
  if (!summary) {
    const s = await summarize($, options, p, files)
    summary = s.summary
    model = s.model
    // Cached so a retry neither pays for nor changes the summary.
    await $.store.set(k, { ...p, attempts, leaseUntil: now + LEASE_MS, summary, summaryModel: model })
  }
  const res = await $.http.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify(buildBody(p, files, summary, model)),
  })
  if (res.ok || [400, 413, 422].includes(res.status)) {
    // Accepted, or permanently malformed: retrying would not help.
    await $.store.delete(k)
    if (!res.ok) await log($, 'rejected ' + p.entryId, res.status + ' ' + String(res.text ?? '').slice(0, 120))
  } else {
    await log($, 'post ' + p.entryId, 'status ' + res.status)
    const cur = await $.store.get(k)
    if (cur) await $.store.set(k, { ...cur, leaseUntil: 0 })
  }
}

async function flushAll($, options) {
  if (!enabled(options)) return
  await promoteStale($, await $.clock.now())
  const keys = (await $.store.keys()).filter((k) => k.startsWith('pending:'))
  if (keys.length === 0) return
  const url = options.luna_url || (await $.env.get('LUNA_JOURNAL_URL'))
  const token = await resolveToken($, options)
  if (!url || !token) {
    await log($, 'config', 'missing journal URL or token; entries kept')
    return
  }
  for (const k of keys) {
    try {
      await flushOne($, options, k, url, token)
    } catch (err) {
      // Network refused or timed out: keep the entry for the next session.
      await log($, 'flush ' + k.slice(8), err)
      try {
        const cur = await $.store.get(k)
        if (cur) await $.store.set(k, { ...cur, leaseUntil: 0 })
      } catch {}
    }
  }
}

export function register(on, options = {}) {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    if (!enabled(options)) return r
    try {
      const sid = await $.session.id()
      const acc = await newAccumulator($, sid, e.cwd || (await $.session.cwd()), e.surface)
      await $.store.set('sess:' + sid, acc)
    } catch (err) {
      await log($, 'start', err)
    }
    $.clock.after(FLUSH_DELAY_MS, () => flushAll($, options).catch(() => {}))
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!enabled(options) || e.agentId || !e.answer) return r
    try {
      const acc = await loadAccumulator($)
      acc.turns.push({ a: redact(e.answer).slice(0, ANSWER_CAP) })
      if (acc.turns.length > MAX_TURNS) acc.turns.splice(0, acc.turns.length - MAX_TURNS)
      await snapshotGit($, acc)
      acc.lastActivityAt = await $.clock.now()
      await $.store.set('sess:' + acc.sid, acc)
    } catch (err) {
      await log($, 'turn', err)
    }
    return r
  })

  on('tool.call', { tool: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] }, async ($, e, next) => {
    const r = await next(e)
    if (!enabled(options)) return r
    try {
      const path = e.file_path || e.notebook_path
      if (!path || r?.deny || r?.isError) return r
      const acc = await loadAccumulator($)
      if (!acc.files.includes(path) && acc.files.length < MAX_FILES) {
        acc.files.push(path)
        acc.lastActivityAt = await $.clock.now()
        await $.store.set('sess:' + acc.sid, acc)
      }
    } catch {}
    return r
  })

  on('session.end', async ($, e, next) => {
    try {
      const acc = await $.store.get('sess:' + e.sessionId)
      if (acc && (acc.turns.length || acc.files.length)) {
        const now = await $.clock.now()
        const entryId = makeEntryId(e.sessionId, now)
        await $.store.set('pending:' + entryId, { ...acc, entryId, endedAt: now, reason: e.reason, attempts: 0 })
      }
      if (acc) await $.store.delete('sess:' + e.sessionId)
    } catch {}
    return next(e)
  })
}
