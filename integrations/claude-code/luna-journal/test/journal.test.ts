import { expect, mock, test } from 'claude-code/testing'
import {
  buildBody,
  buildPrompt,
  clampSummary,
  cleanFiles,
  makeEntryId,
  porcelainPaths,
  redact,
  redactPath,
  storedBytes,
} from '../hooks/lib.js'

const HOUR = 3600e3
const T0 = Date.parse('2026-10-06T10:00:00Z')
const SECRET = 'sk-ant-' + 'A'.repeat(24)

type Opts = {
  env?: Record<string, string>
  store?: Record<string, unknown>
  fetchStatus?: number[]
  fetchThrows?: boolean
  // The deny message for a throwing fetch or model call.
  fetchDeny?: string
  modelDeny?: string
  // Every process.run answers only once the test clock has moved this far.
  slowProcessMs?: number
  model?: 'ok' | 'unanswered' | 'throws'
  now?: number
  // Session id per call of session.id; a string for a fixed one.
  sid?: string | (() => string)
  // Mutable repo state: HEAD, and what `git diff --name-only <args>` prints.
  git?: { head: string; diff: Record<string, string> }
  // Where `git rev-parse --show-toplevel` lands, and what session.repo reports.
  toplevel?: string
  repoRoot?: string
  cwd?: string
  // While `on` is true, store.set on a sess: key is refused (rejects in the mod).
  sessSetFails?: { on: boolean }
}

// Registers every stub the mod needs. Must run before the test's first $ call.
function rig(on: any, o: Opts = {}) {
  const saved = new Map<string, unknown>(Object.entries(o.store ?? {}))
  const fetches: Array<{ url: string; init: any }> = []
  const modelCalls: unknown[] = []
  const runs: Array<{ argv: string; cwd: string | undefined }> = []
  // Every tool call that reached Claude Code's own behavior, as it arrived.
  const toolCalls: unknown[] = []
  const statuses = [...(o.fetchStatus ?? [200])]
  const clock = mock.clock(on, { now: o.now ?? T0 })
  mock.env(on, o.env ?? {})
  on('store.get', ($: any, e: any) => ({ value: saved.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    if (o.sessSetFails?.on && String(e.key).startsWith('sess:')) return { deny: 'store unavailable' }
    saved.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', ($: any, e: any) => {
    saved.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...saved.keys()] }))
  on('session.id', () => ({ value: typeof o.sid === 'function' ? o.sid() : o.sid ?? 's1-0000-session' }))
  on('session.cwd', () => ({ value: o.cwd ?? '/r' }))
  on('session.repo', () => ({ value: { root: o.repoRoot ?? '/r', name: null, remote: null, internal: false } }))
  on('session.version', () => ({ value: { version: '2.1.291' } }))
  on('process.run', async ($: any, e: any) => {
    if (o.slowProcessMs) await clock.sleep(o.slowProcessMs)
    const a = e.argv.join(' ')
    runs.push({ argv: a, cwd: e.init?.cwd })
    if (a === 'git rev-parse --show-toplevel') return { value: { exitCode: 0, stdout: (o.toplevel ?? '/r') + '\n', stderr: '' } }
    if (a === 'git branch --show-current') return { value: { exitCode: 0, stdout: 'main\n', stderr: '' } }
    if (a === 'git rev-parse HEAD') return { value: { exitCode: 0, stdout: (o.git?.head ?? 'abc1234def5678') + '\n', stderr: '' } }
    if (o.git && e.argv[1] === 'diff') {
      return { value: { exitCode: 0, stdout: o.git.diff[e.argv.slice(3).join(' ')] ?? '', stderr: '' } }
    }
    if (a === 'hostname -s') return { value: { exitCode: 0, stdout: 'testmac\n', stderr: '' } }
    if (e.argv[0] === 'git') return { value: { exitCode: 0, stdout: '', stderr: '' } }
    return { value: { exitCode: 1, stdout: '', stderr: 'not found' } }
  })
  on('model.complete', ($: any, e: any) => {
    modelCalls.push(e)
    if (o.model === 'throws') return { deny: o.modelDeny ?? 'model not allowed' }
    if (o.model === 'unanswered') {
      return { value: { isAnswered: false, reason: 'api-error', usage: null } }
    }
    return { value: { isAnswered: true, text: 'Did X.\nChanged Y.', usage: null } }
  })
  on('http.fetch', ($: any, e: any) => {
    fetches.push({ url: e.url, init: e.init })
    if (o.fetchThrows) return { deny: o.fetchDeny ?? 'connection refused' }
    const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!
    return { value: { status, ok: status >= 200 && status < 300, headers: {}, text: '{}' } }
  })
  on('session.start', () => ({ cwd: '/r' }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', ($: any, e: any) => ({ sessionId: e.sessionId }))
  on('tool.call', ($: any, e: any) => {
    // tool_use_id is minted by the kit per call, so it is left out.
    const { tool_use_id: _id, ...args } = e
    toolCalls.push(JSON.parse(JSON.stringify(args)))
    return e.tool === 'Write' ? { deny: 'no' } : { result: 'ok' }
  })
  return { saved, fetches, modelCalls, clock, runs, toolCalls }
}

const pendingKeys = (saved: Map<string, unknown>) => [...saved.keys()].filter((k) => k.startsWith('pending:'))

const turn = (answer: string, extra: Record<string, unknown> = {}) => ({
  turnId: 't' + Math.random(),
  answer,
  durationMs: 5,
  isAborted: false,
  usage: null,
  ...extra,
})

async function runSession($: any, answers: string[]) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  for (const a of answers) await $.turn.complete(turn(a))
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1-0000-session', resume: { id: 's1-0000-session' } })
}

const pendingEntry = (over: Record<string, unknown> = {}) => ({
  sid: 'old-session-1',
  cwd: '/r',
  repo: 'r',
  branch: 'main',
  startSha: 'abc1234',
  headSha: 'abc1234',
  startedAt: T0 - HOUR,
  endedAt: T0 - 60e3,
  lastActivityAt: T0 - 60e3,
  turns: [{ a: 'Edited foo ' + SECRET }],
  files: ['/r/a.ts'],
  gitFiles: [],
  host: 'testmac',
  client: 'claude-code-cli',
  clientVersion: '2.1.291',
  entryId: 'old-session-1-abc',
  reason: 'prompt_input_exit',
  attempts: 0,
  ...over,
})

test('session.end only queues: no network, no model', async ($, on) => {
  const r = rig(on)
  await runSession($, ['Edited foo', 'Ran tests'])
  const keys = pendingKeys(r.saved)
  expect(keys.length).toBe(1)
  expect(r.saved.has('sess:s1-0000-session')).toBe(false)
  expect(r.fetches.length).toBe(0)
  expect(r.modelCalls.length).toBe(0)
  const p = r.saved.get(keys[0]!) as any
  expect(p.reason).toBe('prompt_input_exit')
  expect(p.turns.length).toBe(2)
  expect(p.client).toBe('claude-code-cli')
})

test('subagent turns are ignored', async ($, on) => {
  const r = rig(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.turn.complete(turn('main answer'))
  await $.turn.complete(turn('subagent answer', { agentId: 'a' }))
  const acc = r.saved.get('sess:s1-0000-session') as any
  expect(acc.turns.length).toBe(1)
})

test('tool.call records edits and skips denied calls', async ($, on) => {
  const r = rig(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.tool.call({ tool: 'Edit', file_path: '/r/a.ts', old_string: 'x', new_string: 'y' })
  await $.tool.call({ tool: 'Write', file_path: '/r/b.ts', content: 'z' })
  const acc = r.saved.get('sess:s1-0000-session') as any
  expect(acc.files).toEqual(['/r/a.ts'])
})

test('a failing edit bookkeeping step lets the tool call through unchanged', async ($, on) => {
  const failing = { on: false }
  const r = rig(on, { sessSetFails: failing })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  failing.on = true
  const edit = { tool: 'Edit', file_path: '/r/a.ts', old_string: 'x', new_string: 'y' }
  const write = { tool: 'Write', file_path: '/r/b.ts', content: 'z' }
  // The store refusing the write makes recordEdit throw inside the hook.
  expect(await $.tool.call(edit)).toEqual({ result: 'ok' })
  // A denied call keeps its denial: the mod neither lifts nor rewrites it.
  expect(await $.tool.call(write)).toEqual({ deny: 'no' })
  // Each call reached Claude Code exactly once, with its arguments untouched:
  // the .catch replays the settled result instead of running the tool again.
  expect(r.toolCalls).toEqual([edit, write])
  expect((r.saved.get('log') as any[]).map((l) => l.what)).toEqual(['tool'])
  expect((r.saved.get('sess:s1-0000-session') as any).files).toEqual([])
  // Once the store recovers, recording resumes.
  failing.on = false
  expect(await $.tool.call(edit)).toEqual({ result: 'ok' })
  expect((r.saved.get('sess:s1-0000-session') as any).files).toEqual(['/r/a.ts'])
})

test('a failing lazy accumulator write also fails open', async ($, on) => {
  const failing = { on: true }
  const r = rig(on, { sessSetFails: failing })
  // No session.start: the hook creates the accumulator lazily, and that write fails.
  const edit = { tool: 'Edit', file_path: '/r/a.ts', old_string: 'x', new_string: 'y' }
  expect(await $.tool.call(edit)).toEqual({ result: 'ok' })
  expect(r.toolCalls).toEqual([edit])
  expect(r.saved.has('sess:s1-0000-session')).toBe(false)
})

test('flush posts a redacted body 15s into the next session and deletes on 200', async ($, on) => {
  const r = rig(on, { env: { LUNA_JOURNAL_TOKEN: 'tok', LUNA_JOURNAL_URL: 'http://luna.test/v1/journal' }, store: { 'pending:e1': pendingEntry() } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  expect(r.fetches.length).toBe(0)
  await r.clock.advance(15000)
  await r.clock.settle()
  expect(r.fetches.length).toBe(1)
  const f = r.fetches[0]!
  expect(f.url).toBe('http://luna.test/v1/journal')
  expect(f.init.method).toBe('POST')
  expect(f.init.headers.authorization).toBe('Bearer tok')
  const body = JSON.parse(f.init.body)
  expect(body.files_changed).toEqual(['a.ts'])
  expect(body.summary_model).toBe('haiku')
  expect(body.summary).toBe('Did X.\nChanged Y.')
  expect(body.entry_id).toBe('old-session-1-abc')
  expect(f.init.body).not.toContain('sk-ant')
  expect(JSON.stringify(r.modelCalls)).not.toContain('sk-ant')
  expect(r.saved.has('pending:e1')).toBe(false)
})

test('model unanswered uses the fallback summary', async ($, on) => {
  const r = rig(on, { model: 'unanswered', env: { LUNA_JOURNAL_TOKEN: 'tok', LUNA_JOURNAL_URL: 'http://luna.test/v1/journal' }, store: { 'pending:e1': pendingEntry() } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await r.clock.advance(15000)
  await r.clock.settle()
  const body = JSON.parse(r.fetches[0]!.init.body)
  expect(body.summary_model).toBe('fallback')
  expect(body.summary).toMatch(/^1 turn\(s\) in r@main\. 1 file\(s\) changed: a\.ts\.$/)
})

test('model throwing uses the fallback summary', async ($, on) => {
  const r = rig(on, { model: 'throws', env: { LUNA_JOURNAL_TOKEN: 'tok', LUNA_JOURNAL_URL: 'http://luna.test/v1/journal' }, store: { 'pending:e1': pendingEntry() } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await r.clock.advance(15000)
  await r.clock.settle()
  expect(JSON.parse(r.fetches[0]!.init.body).summary_model).toBe('fallback')
})

test('5xx keeps the entry and a retry reuses entry_id and the cached summary', async ($, on) => {
  const r = rig(on, { fetchStatus: [500, 200], env: { LUNA_JOURNAL_TOKEN: 'tok', LUNA_JOURNAL_URL: 'http://luna.test/v1/journal' }, store: { 'pending:e1': pendingEntry() } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await r.clock.advance(15000)
  await r.clock.settle()
  const kept = r.saved.get('pending:e1') as any
  expect(kept.attempts).toBe(1)
  expect(kept.summary).toBe('Did X.\nChanged Y.')
  expect(r.modelCalls.length).toBe(1)
  // The next session's flush.
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await r.clock.advance(15000)
  await r.clock.settle()
  expect(r.fetches.length).toBe(2)
  expect(r.modelCalls.length).toBe(1)
  expect(JSON.parse(r.fetches[1]!.init.body).entry_id).toBe(JSON.parse(r.fetches[0]!.init.body).entry_id)
  expect(r.saved.has('pending:e1')).toBe(false)
})

test('422 drops the entry permanently and logs it', async ($, on) => {
  const r = rig(on, { fetchStatus: [422], env: { LUNA_JOURNAL_TOKEN: 'tok', LUNA_JOURNAL_URL: 'http://luna.test/v1/journal' }, store: { 'pending:e1': pendingEntry() } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await r.clock.advance(15000)
  await r.clock.settle()
  expect(r.saved.has('pending:e1')).toBe(false)
  const log = r.saved.get('log') as any[]
  expect(log.some((l) => l.what === 'rejected' && l.status === 422)).toBe(true)
})

test('a network failure escapes nothing and keeps the entry', async ($, on) => {
  const r = rig(on, { fetchThrows: true, env: { LUNA_JOURNAL_TOKEN: 'tok', LUNA_JOURNAL_URL: 'http://luna.test/v1/journal' }, store: { 'pending:e1': pendingEntry() } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await r.clock.advance(15000)
  await r.clock.settle()
  expect(r.fetches.length).toBe(1)
  const kept = r.saved.get('pending:e1') as any
  expect(kept.attempts).toBe(1)
  expect(kept.leaseUntil).toBe(0)
  expect(JSON.stringify(r.saved.get('log'))).not.toContain('tok')
})

test('exhausted attempts drop the entry without fetching', async ($, on) => {
  const r = rig(on, { env: { LUNA_JOURNAL_TOKEN: 'tok', LUNA_JOURNAL_URL: 'http://luna.test/v1/journal' }, store: { 'pending:e1': pendingEntry({ attempts: 5 }) } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await r.clock.advance(15000)
  await r.clock.settle()
  expect(r.fetches.length).toBe(0)
  expect(r.saved.has('pending:e1')).toBe(false)
  expect((r.saved.get('log') as any[]).some((l) => l.what === 'drop-expired')).toBe(true)
})

test('no token: nothing is sent, the entry is kept and the gap is logged', async ($, on) => {
  const r = rig(on, { env: { LUNA_JOURNAL_URL: 'http://luna.test/v1/journal' }, store: { 'pending:e1': pendingEntry() } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await r.clock.advance(15000)
  await r.clock.settle()
  expect(r.fetches.length).toBe(0)
  expect(r.saved.has('pending:e1')).toBe(true)
  expect((r.saved.get('log') as any[]).some((l) => l.what === 'config-missing')).toBe(true)
})

test('a session idle for more than 6h is recovered as a pending entry', async ($, on) => {
  const stale = { ...pendingEntry(), lastActivityAt: T0 - 7 * HOUR }
  const r = rig(on, { store: { 'sess:old-session-1': stale } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await r.clock.advance(15000)
  await r.clock.settle()
  expect(r.saved.has('sess:old-session-1')).toBe(false)
  const keys = pendingKeys(r.saved)
  expect(keys.length).toBe(1)
  const p = r.saved.get(keys[0]!) as any
  expect(p.reason).toBe('crash-recovered')
  expect(p.endedAt).toBe(T0 - 7 * HOUR)
  // The id minted with the accumulator, not one derived from promotion time.
  expect(p.entryId).toBe('old-session-1-abc')
})

test('an empty session is not journaled', async ($, on) => {
  const r = rig(on)
  await runSession($, [])
  expect(pendingKeys(r.saved).length).toBe(0)
  expect(r.saved.has('sess:s1-0000-session')).toBe(false)
})

test('session.start captures client surface and host', async ($, on) => {
  const r = rig(on)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/r' })
  await r.clock.settle()
  const acc = r.saved.get('sess:s1-0000-session') as any
  expect(acc.client).toBe('claude-code-desktop')
  expect(acc.host).toBe('testmac')
})

test('lib: redact covers each secret shape', async () => {
  const samples = [
    SECRET,
    'ghp_' + 'B'.repeat(36),
    'github_pat_' + 'C'.repeat(42),
    'AKIA' + 'D'.repeat(16),
    'xoxb-' + '1'.repeat(12),
    'AIza' + 'E'.repeat(35),
    '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
    'eyJ' + 'a'.repeat(12) + '.' + 'b'.repeat(12) + '.' + 'c'.repeat(12),
    'Q'.repeat(50),
  ]
  for (const s of samples) expect(redact('x ' + s + ' y')).toBe('x [REDACTED] y')
  expect(redact('x password=hunter2hunter2 y')).toBe('x password=[REDACTED] y')
  expect(redact('plain words stay')).toBe('plain words stay')
})

test('lib: cleanFiles makes paths relative, masks secrets files, dedupes', async () => {
  expect(cleanFiles(['/r/a.ts', 'a.ts', '/r/.env', 'cfg/.env.local', '/r/keys/id_ed25519', ''], '/r')).toEqual([
    'a.ts',
    '[sensitive-file]',
    'cfg/[sensitive-file]',
    'keys/[sensitive-file]',
  ])
  expect(porcelainPaths(' M a.ts\nR  old.ts -> new.ts\n?? "sp ace.ts"')).toEqual(['a.ts', 'new.ts', 'sp ace.ts'])
})

test('lib: clampSummary keeps at most 4 non-empty lines and redacts', async () => {
  expect(clampSummary('1\n\n2\n3\n4\n5\n6')).toBe('1\n2\n3\n4')
  expect(clampSummary('token: ' + 'z'.repeat(20))).toBe('token: [REDACTED]')
  expect(clampSummary('ab '.repeat(700)).length).toBe(1200)
})

test('lib: buildBody fits the server validator caps', async () => {
  const body = buildBody(
    { ...pendingEntry(), sid: 'a b/c', repo: 'r'.repeat(150), headSha: 'NOTHEX', reason: 'weird', client: 'vim' } as any,
    ['a.ts'],
    'S',
    'haiku',
  )
  expect(body.session_id).toBe('abc-session')
  expect(body.repo.length).toBe(100)
  expect(body.head_sha).toBeUndefined()
  expect(body.end_reason).toBe('other')
  expect(body.client).toBe('claude-code')
  expect(body.started_at).toBe(new Date(T0 - HOUR).toISOString())
  expect(makeEntryId('s1', 1000)).toMatch(/^e-[0-9a-z]+-rs$/)
  expect(makeEntryId('s1', 1000)).toBe(makeEntryId('s1', 1000))
  expect(makeEntryId('s1', 1000)).not.toBe(makeEntryId('s2', 1000))
})

test('a worktree session runs git in its own toplevel, not the main tree', async ($, on) => {
  const r = rig(on, { toplevel: '/wt/feat', repoRoot: '/main/luna', cwd: '/wt/feat/sub' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/wt/feat/sub' })
  await $.tool.call({ tool: 'Edit', file_path: '/wt/feat/a.ts', old_string: 'x', new_string: 'y' })
  await $.turn.complete(turn('did it'))
  await r.clock.settle()
  const acc = r.saved.get('sess:s1-0000-session') as any
  expect(acc.cwd).toBe('/wt/feat')
  expect(acc.repo).toBe('luna')
  const gitRuns = r.runs.filter((x) => x.argv.startsWith('git '))
  expect(gitRuns.find((x) => x.argv === 'git rev-parse --show-toplevel')?.cwd).toBe('/wt/feat/sub')
  for (const x of gitRuns.filter((x) => x.argv !== 'git rev-parse --show-toplevel')) expect(x.cwd).toBe('/wt/feat')
  expect(gitRuns.some((x) => x.cwd === '/main/luna')).toBe(false)
  const body = buildBody({ ...acc, entryId: 'e', endedAt: T0, reason: 'other' }, cleanFiles(acc.files, acc.cwd), 'S', 'haiku')
  expect(body.files_changed).toEqual(['a.ts'])
  expect(body.repo_path).toBe('/wt/feat')
  expect(body.repo).toBe('luna')
})

test('a second session.start (mod reload) keeps the turns and files so far', async ($, on) => {
  const r = rig(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await r.clock.settle()
  await $.turn.complete(turn('first'))
  await $.tool.call({ tool: 'Edit', file_path: '/r/a.ts', old_string: 'x', new_string: 'y' })
  const before = r.saved.get('sess:s1-0000-session') as any
  await r.clock.advance(60e3)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  const acc = r.saved.get('sess:s1-0000-session') as any
  expect(acc.turns.map((t: any) => t.a)).toEqual(['first'])
  expect(acc.files).toEqual(['/r/a.ts'])
  expect(acc.startedAt).toBe(before.startedAt)
  expect(acc.startSha).toBe(before.startSha)
})

test('a reload fills in the client a lazily created accumulator lacked', async ($, on) => {
  const r = rig(on)
  await $.turn.complete(turn('before start'))
  expect((r.saved.get('sess:s1-0000-session') as any).client).toBe('claude-code')
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/r' })
  const acc = r.saved.get('sess:s1-0000-session') as any
  expect(acc.client).toBe('claude-code-desktop')
  expect(acc.turns.length).toBe(1)
})

test('parallel edits and a turn all land in the accumulator', async ($, on) => {
  const r = rig(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  const paths = Array.from({ length: 8 }, (_, i) => `/r/f${i}.ts`)
  await Promise.all([
    ...paths.map((p) => $.tool.call({ tool: 'Edit', file_path: p, old_string: 'x', new_string: 'y' })),
    $.turn.complete(turn('t1')),
    $.turn.complete(turn('t2')),
  ])
  const acc = r.saved.get('sess:s1-0000-session') as any
  expect([...acc.files].sort()).toEqual([...paths].sort())
  expect(acc.turns.length).toBe(2)
})

for (const status of [401, 403, 503]) {
  test(`${status} keeps every entry, counts no attempt and stops the flush`, async ($, on) => {
    const r = rig(on, {
      fetchStatus: [status],
      env: { LUNA_JOURNAL_TOKEN: 'tok', LUNA_JOURNAL_URL: 'http://luna.test/v1/journal' },
      store: { 'pending:e1': pendingEntry({ attempts: 4 }), 'pending:e2': pendingEntry({ entryId: 'old-session-1-def', attempts: 4 }) },
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
    await r.clock.advance(15000)
    await r.clock.settle()
    expect(r.fetches.length).toBe(1)
    for (const k of ['pending:e1', 'pending:e2']) {
      const kept = r.saved.get(k) as any
      expect(kept.attempts).toBe(4)
      expect(kept.leaseUntil || 0).toBe(0)
    }
    expect((r.saved.get('log') as any[]).some((l) => l.what === 'config' && l.status === status)).toBe(true)
  })
}

// 32 chars, not hex, no known prefix: only the key, the scheme or the exact
// configured value can give it away.
const TOK = 'Lj7' + 'qZ'.repeat(14) + 'x9'
const URL_ENV = { LUNA_JOURNAL_URL: 'http://luna.test/v1/journal' }

const within = (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => true), new Promise<boolean>((res) => setTimeout(() => res(false), ms))])

test('lib: redact drops the whole value for credential keys, auth schemes and URLs', async () => {
  const cases = [
    `export LUNA_JOURNAL_TOKEN=${TOK}`,
    `Authorization: Bearer ${TOK}`,
    `curl -H "Authorization: token ${TOK}" https://x`,
    `curl -H 'authorization: Basic ${TOK}'`,
    `x-api-key: ${TOK}`,
    `GITHUB_TOKEN=${TOK}`,
    `{"client_secret": "${TOK} with space"}`,
    `MY_PASSWD=${TOK}`,
    `session_cookie=${TOK}`,
    `aws_access_key_id = ${TOK}`,
    `DB_PWD: ${TOK}`,
    `credential=${TOK}`,
    `https://user:${TOK}@example.com/repo.git`,
    `https://${TOK}@example.com/repo.git`,
    `https://example.com/cb?state=1&access_token=${TOK}&x=2`,
    `https://example.com/x?sig=${TOK}`,
    `sent Bearer ${TOK} upstream`,
  ]
  for (const c of cases) {
    const out = redact(c)
    expect(out).not.toContain(TOK.slice(0, 10))
    expect(out).toContain('[REDACTED]')
  }
  expect(redact(`Authorization: Bearer ${TOK}`)).toBe('Authorization: [REDACTED]')
  expect(redact('https://example.com/cb?page=2')).toBe('https://example.com/cb?page=2')
  // Only the exact configured value catches a token with no context at all.
  expect(redact(`glued${TOK}glued`)).toContain(TOK)
  expect(redact(`glued${TOK}glued`, [TOK])).toBe('glued[REDACTED]glued')
  expect(redact('short words stay', ['short'])).toBe('short words stay')
})

test('lib: a credential key in a path keeps the rest of the path', async () => {
  expect(redactPath('/r/TOKEN=x/a.ts')).toBe('/r/TOKEN=[REDACTED]/a.ts')
  expect(redactPath(`/r/api_key=${TOK}/sub/a.ts`)).toBe('/r/api_key=[REDACTED]/sub/a.ts')
  // In a query string the value runs to & or #: a '/' does not end it.
  expect(redactPath('/r/cb?access_token=x/a.ts')).toBe('/r/cb?access_token=[REDACTED]')
  expect(cleanFiles(['/r/TOKEN=x/a.ts'], '/r')).toEqual(['TOKEN=[REDACTED]/a.ts'])
  // Prose keeps the whole value, slashes included.
  expect(redact(`TOKEN=${TOK}/more`)).toBe('TOKEN=[REDACTED]')
})

test('lib: key => value drops the whole value', async () => {
  expect(redact(`'Authorization' => "Bearer ${TOK}"`)).toBe(`'Authorization' => [REDACTED]`)
  expect(redact(`Authorization => "Bearer ${TOK}"`)).toBe('Authorization => [REDACTED]')
  expect(redact(`:api_key => ${TOK},`)).toBe(':api_key => [REDACTED],')
  expect(redact(`password=>'${TOK}'`)).toBe('password=>[REDACTED]')
})

test('lib: file paths, repo and branch are redacted before the prompt and the body', async () => {
  const files = cleanFiles([`/r/notes/${TOK}.md`, '/r/ok.ts'], '/r', [TOK])
  expect(files).toEqual(['notes/[REDACTED].md', 'ok.ts'])
  const p = { ...pendingEntry(), branch: `feat/${TOK}`, cwd: `/home/${TOK}/r`, turns: [{ a: `saw ${TOK}` }] }
  const prompt = buildPrompt(p, [`raw/${TOK}.txt`], [TOK])
  expect(prompt).not.toContain(TOK)
  const body = JSON.stringify(buildBody(p as any, [`raw/${TOK}.txt`], `Summary ${TOK}`, 'haiku', [TOK]))
  expect(body).not.toContain(TOK)
})

test('a configured token never reaches the store, the model or the body', async ($, on) => {
  const r = rig(on, { env: { LUNA_JOURNAL_TOKEN: TOK, ...URL_ENV } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.turn.complete(
    turn(`Ran export LUNA_JOURNAL_TOKEN=${TOK}; curl -H "Authorization: Bearer ${TOK}"; the value was ${TOK}.`),
  )
  await $.tool.call({ tool: 'Edit', file_path: `/r/notes/${TOK}.md`, old_string: 'x', new_string: 'y' })
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1-0000-session', resume: { id: 's1-0000-session' } })
  expect(JSON.stringify([...r.saved.entries()])).not.toContain(TOK)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await r.clock.advance(15000)
  await r.clock.settle()
  expect(r.fetches.length).toBe(1)
  expect(r.fetches[0]!.init.body).not.toContain(TOK)
  expect(JSON.stringify(r.modelCalls)).not.toContain(TOK)
  expect(JSON.parse(r.fetches[0]!.init.body).files_changed).toEqual(['notes/[REDACTED].md'])
})

test('failure logs hold fixed categories and status codes, never messages', async ($, on) => {
  const leak = `ECONNRESET sending authorization: Bearer ${TOK}`
  const r = rig(on, {
    fetchThrows: true,
    fetchDeny: leak,
    model: 'throws',
    modelDeny: leak,
    env: { LUNA_JOURNAL_TOKEN: TOK, ...URL_ENV },
    store: { 'pending:e1': pendingEntry() },
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await r.clock.advance(15000)
  await r.clock.settle()
  const log = r.saved.get('log') as any[]
  expect(log.map((l) => l.what)).toEqual(['model-error', 'network'])
  for (const l of log) expect(Object.keys(l).sort()).toEqual(['at', 'what'])
  expect(JSON.stringify(log)).not.toContain(TOK)
  expect(JSON.stringify(log).toLowerCase()).not.toContain('authorization')
})

test('the entry id is minted when the segment starts and reused at session.end', async ($, on) => {
  const r = rig(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  const id = (r.saved.get('sess:s1-0000-session') as any).entryId
  expect(id).toBe(makeEntryId('s1-0000-session', T0))
  await r.clock.advance(HOUR)
  await $.turn.complete(turn('work'))
  await $.session.end({ reason: 'clear', sessionId: 's1-0000-session', resume: { id: 's1-0000-session' } })
  expect(pendingKeys(r.saved)).toEqual(['pending:' + id])
})

test('an interrupted promotion keeps the queued copy and its cached summary', async ($, on) => {
  // Crashed after writing the pending entry and before deleting the session.
  const stale = { ...pendingEntry(), lastActivityAt: T0 - 7 * HOUR }
  const queued = { ...pendingEntry(), attempts: 2, summary: 'Cached.', summaryModel: 'haiku' }
  const r = rig(on, {
    env: { LUNA_JOURNAL_TOKEN: 'tok', ...URL_ENV },
    store: { 'sess:old-session-1': stale, 'pending:old-session-1-abc': queued },
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await r.clock.advance(15000)
  await r.clock.settle()
  expect(r.fetches.length).toBe(1)
  expect(r.modelCalls.length).toBe(0)
  const body = JSON.parse(r.fetches[0]!.init.body)
  expect(body.entry_id).toBe('old-session-1-abc')
  expect(body.summary).toBe('Cached.')
  expect(r.saved.has('sess:old-session-1')).toBe(false)
  expect(pendingKeys(r.saved)).toEqual([])
})

test('promoting the same segment at two different times sends one entry id', async ($, on) => {
  // An older accumulator without a stored id: the id derives from its start.
  const { entryId: _drop, ...legacy } = { ...pendingEntry(), lastActivityAt: T0 - 7 * HOUR }
  const r = rig(on, { env: { LUNA_JOURNAL_TOKEN: 'tok', ...URL_ENV }, store: { 'sess:old-session-1': legacy } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await r.clock.advance(15000)
  await r.clock.settle()
  // A second process still holding the same stale copy promotes it an hour later.
  r.saved.set('sess:old-session-1', legacy)
  await r.clock.advance(HOUR)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await r.clock.advance(15000)
  await r.clock.settle()
  expect(r.fetches.length).toBe(2)
  const ids = r.fetches.map((f) => JSON.parse(f.init.body).entry_id)
  expect(ids[0]).toBe(ids[1])
  expect(ids[0]).toBe(makeEntryId('old-session-1', T0 - HOUR))
})

test('two concurrent flushes of a stale session queue and send it once', async ($, on) => {
  const stale = { ...pendingEntry(), lastActivityAt: T0 - 7 * HOUR }
  const r = rig(on, { env: { LUNA_JOURNAL_TOKEN: 'tok', ...URL_ENV }, store: { 'sess:old-session-1': stale } })
  await Promise.all([
    $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' }),
    $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' }),
  ])
  await r.clock.advance(15000)
  await r.clock.settle()
  expect(r.fetches.length).toBe(1)
  expect(pendingKeys(r.saved)).toEqual([])
})

test('session.start and turn.complete return while git is still running', async ($, on) => {
  const r = rig(on, { slowProcessMs: 60000 })
  expect(await within($.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' }), 300)).toBe(true)
  expect(await within($.turn.complete(turn('quick')), 300)).toBe(true)
  const acc = r.saved.get('sess:s1-0000-session') as any
  expect(acc.turns.map((t: any) => t.a)).toEqual(['quick'])
  expect(acc.host).toBe('')
  for (let i = 0; i < 4; i++) {
    await r.clock.advance(60000)
    await r.clock.settle()
  }
  const done = r.saved.get('sess:s1-0000-session') as any
  expect(done.host).toBe('testmac')
  expect(done.startSha).toBe('abc1234def5678')
})

test('a long outage with no token still expires and caps the queue', async ($, on) => {
  const store: Record<string, unknown> = {}
  for (let i = 0; i < 60; i++) {
    store[`pending:e${i}`] = pendingEntry({ entryId: `old-session-1-${i}`, endedAt: T0 - (60 - i) * 60e3 })
  }
  store['pending:old'] = pendingEntry({ entryId: 'old-session-1-old', endedAt: T0 - 8 * 86400e3 })
  const r = rig(on, { env: URL_ENV, store })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await r.clock.advance(15000)
  await r.clock.settle()
  const keys = pendingKeys(r.saved)
  expect(keys.length).toBe(50)
  expect(r.saved.has('pending:old')).toBe(false)
  // The oldest ten went; the newest stayed.
  for (let i = 0; i < 10; i++) expect(r.saved.has(`pending:e${i}`)).toBe(false)
  expect(r.saved.has('pending:e59')).toBe(true)
  const whats = (r.saved.get('log') as any[]).map((l) => l.what)
  expect(whats).toContain('drop-expired')
  expect(whats).toContain('drop-overflow')
  expect(whats).toContain('config-missing')
})

test('the queue stays under its byte limit', async ($, on) => {
  const store: Record<string, unknown> = {}
  for (let i = 0; i < 5; i++) {
    store[`pending:b${i}`] = pendingEntry({ entryId: `old-session-1-b${i}`, endedAt: T0 - (5 - i) * 60e3, turns: [{ a: 'w'.repeat(300 * 1024) }] })
  }
  const r = rig(on, { env: URL_ENV, store })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await r.clock.advance(15000)
  await r.clock.settle()
  const kept = pendingKeys(r.saved)
  expect(kept.sort()).toEqual(['pending:b2', 'pending:b3', 'pending:b4'])
  const bytes = kept.reduce((n, k) => n + JSON.stringify(r.saved.get(k)).length, 0)
  expect(bytes).toBeLessThanOrEqual(1024 * 1024)
})

// Codex probes. The marker must never survive, in prose or in a path.
const EXPOSED = 'exposedSuffix9876'
const both = (s: string) => [redact(s), redactPath(s)]

test('lib: an escaped quote does not end a quoted value', async () => {
  for (const out of both(`{"password":"prefix\\"${EXPOSED}"}`)) {
    expect(out).not.toContain(EXPOSED)
    expect(out).toBe('{"password":[REDACTED]}')
  }
  // Escaped JSON inside a string, and an unterminated quote.
  expect(redact(`log: {\\"api_key\\":\\"${EXPOSED}\\"}`)).not.toContain(EXPOSED)
  expect(redact(`password="abc ${EXPOSED}`)).not.toContain(EXPOSED)
})

test('lib: adjacent shell quotes are one value', async () => {
  for (const c of [
    `TOKEN='abc'"${EXPOSED}"`,
    `export SECRET="a"'b'${EXPOSED}`,
    `PASSWORD=abc'${EXPOSED}'`,
    `api_key="x\\"y"'${EXPOSED}'`,
  ]) {
    for (const out of both(c)) {
      expect(out).not.toContain(EXPOSED)
      expect(out).toContain('[REDACTED]')
    }
  }
})

test('lib: credential headers lose their whole value to the end of the line', async () => {
  const cases = [
    `Cookie: theme=dark; sid=${EXPOSED}; lang=en`,
    `cookie: a=1; b=2; c=${EXPOSED}`,
    `Set-Cookie: id=${EXPOSED}; Path=/; HttpOnly`,
    `Authorization: Digest username="bob", realm="x", nonce="n1", response="${EXPOSED}"`,
    `Proxy-Authorization: Basic ${EXPOSED}`,
    `X-Api-Key: two words ${EXPOSED}`,
    `curl -H 'Cookie: a=1; tok=${EXPOSED}' https://example.com`,
    `{"Authorization": "Digest u=\\"x\\", response=\\"${EXPOSED}\\""}`,
  ]
  for (const c of cases) for (const out of both(c)) expect(out).not.toContain(EXPOSED)
  expect(redact(`Cookie: a=1; b=${EXPOSED}\nnext line stays`)).toBe('Cookie: [REDACTED]\nnext line stays')
  expect(redact(`Authorization: Digest username="bob", response="${EXPOSED}"`)).toBe('Authorization: [REDACTED]')
  expect(redact('the cookies were stale')).toBe('the cookies were stale')
})

test('lib: a credential query value keeps going past a slash', async () => {
  for (const out of both(`https://example.com/cb?token=abc/${EXPOSED}`)) {
    expect(out).not.toContain(EXPOSED)
    expect(out).toBe('https://example.com/cb?token=[REDACTED]')
  }
  expect(redactPath(`/r/cb?x=1&access_token=a/b/${EXPOSED}&page=2`)).toBe('/r/cb?x=1&access_token=[REDACTED]&page=2')
  // Names the KEY=value rule does not know (sig, code) rely on the query rule alone.
  for (const c of [`https://x.test/a?sig=abc/${EXPOSED}`, `/r/cb?code=abc/${EXPOSED}&s=1`]) {
    for (const out of both(c)) expect(out).not.toContain(EXPOSED)
  }
  // A KEY=value in a real path segment still stops at '/'.
  expect(redactPath('/r/TOKEN=x/a.ts')).toBe('/r/TOKEN=[REDACTED]/a.ts')
  // After the '?', the path stop no longer applies.
  expect(redactPath(`/r/x?a=1&b=2/secret=v/${EXPOSED}`)).not.toContain(EXPOSED)
})

// 64 chars, not hex.
const TOK64 = 'Mq'.repeat(32)
const carries = (s: string, tok: string) => {
  for (let i = 0; i + 8 <= tok.length; i++) if (s.includes(tok.slice(i, i + 8))) return true
  return false
}

test('lib: a session id or entry id carrying the token is replaced by a hash', async () => {
  const body = buildBody(
    { ...pendingEntry(), sid: TOK64, entryId: TOK64.slice(0, 40) + '-abc' } as any,
    [],
    'S',
    'haiku',
    [TOK64],
  )
  expect(carries(JSON.stringify(body), TOK64)).toBe(false)
  expect(body.session_id).toMatch(/^sid-[0-9a-z]+$/)
  expect(body.entry_id).toMatch(/^e-[0-9a-z]+$/)
  // Stable, so a retry sends the same ids.
  expect(buildBody({ ...pendingEntry(), sid: TOK64 } as any, [], 'S', 'haiku', [TOK64]).session_id).toBe(body.session_id)
  // A new entry id never carries the session id at all.
  expect(carries(makeEntryId(TOK64, T0), TOK64)).toBe(false)
  // Ordinary ids pass through.
  const plain = buildBody(pendingEntry() as any, [], 'S', 'haiku', [TOK64])
  expect(plain.session_id).toBe('old-session-1')
  expect(plain.entry_id).toBe('old-session-1-abc')
})

test('a 64-char token used as the session id never reaches an id, a key or the body', async ($, on) => {
  const r = rig(on, { sid: TOK64, env: { LUNA_JOURNAL_TOKEN: TOK64, ...URL_ENV } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.turn.complete(turn('work'))
  await $.session.end({ reason: 'prompt_input_exit', sessionId: TOK64, resume: { id: TOK64 } })
  for (const k of pendingKeys(r.saved)) expect(carries(k, TOK64)).toBe(false)
  expect(carries(JSON.stringify(pendingKeys(r.saved).map((k) => (r.saved.get(k) as any).entryId)), TOK64)).toBe(false)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await r.clock.advance(15000)
  await r.clock.settle()
  expect(r.fetches.length).toBe(1)
  expect(carries(r.fetches[0]!.init.body, TOK64)).toBe(false)
})

test('60 short sessions with no config keep at most 50 entries without any flush', async ($, on) => {
  let sid = ''
  const r = rig(on, { sid: () => sid })
  for (let i = 0; i < 60; i++) {
    sid = `s${i}-0000-session`
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
    await $.turn.complete(turn('short ' + i))
    await $.session.end({ reason: 'prompt_input_exit', sessionId: sid, resume: { id: sid } })
    expect(pendingKeys(r.saved).length).toBeLessThanOrEqual(50)
    await r.clock.advance(100)
  }
  // Six seconds in: no flush has run, so the cap held at enqueue time.
  expect(r.fetches.length).toBe(0)
  const whats = ((r.saved.get('log') as any[]) ?? []).map((l) => l.what)
  expect(whats).not.toContain('config-missing')
  expect(whats.filter((w) => w === 'drop-overflow').length).toBe(10)
  const keys = pendingKeys(r.saved)
  expect(keys.length).toBe(50)
  for (let i = 0; i < 60; i++) {
    const k = 'pending:' + makeEntryId(`s${i}-0000-session`, T0 + i * 100)
    expect(r.saved.has(k)).toBe(i >= 10)
  }
})

const MIB = 1024 * 1024
// UTF-8 length measured independently of the mod (the test runtime has no Buffer).
const utf8 = (s: string) => encodeURIComponent(s).replace(/%[0-9A-F]{2}/g, '.').length
const totalBytes = (saved: Map<string, unknown>) =>
  pendingKeys(saved).reduce((n, k) => n + utf8(JSON.stringify(saved.get(k))), 0)

test('a multi-byte queue near the byte limit makes room at enqueue, counting UTF-8 bytes', async ($, on) => {
  // Four entries of three-byte characters that fill all but 300 bytes of the
  // limit. By string length they would be a third of it.
  const shape = (i: number, n: number) =>
    pendingEntry({ entryId: `old-session-1-m${i}`, endedAt: T0 - (10 - i) * 60e3, turns: [{ a: '€'.repeat(n) }] })
  const overhead = utf8(JSON.stringify(shape(0, 0)))
  const n = Math.floor(((MIB - 300) / 4 - overhead) / 3)
  const store: Record<string, unknown> = {}
  for (let i = 0; i < 4; i++) store[`pending:m${i}`] = shape(i, n)
  const r = rig(on, { store })
  expect(totalBytes(r.saved)).toBeLessThanOrEqual(MIB)
  expect(totalBytes(r.saved)).toBeGreaterThan(MIB - 400)
  expect(pendingKeys(r.saved).reduce((c, k) => c + JSON.stringify(r.saved.get(k)).length, 0)).toBeLessThan(MIB / 2)
  await runSession($, ['a short session'])
  expect(r.fetches.length).toBe(0)
  const keys = pendingKeys(r.saved)
  expect(keys.length).toBe(4)
  expect(r.saved.has('pending:m0')).toBe(false)
  expect(keys.some((k) => !k.startsWith('pending:m'))).toBe(true)
  expect(totalBytes(r.saved)).toBeLessThanOrEqual(MIB)
  expect(storedBytes('€')).toBe(5)
})

test('flush-time pruning counts UTF-8 bytes, not string length', async ($, on) => {
  const store: Record<string, unknown> = {}
  for (let i = 0; i < 5; i++) {
    store[`pending:u${i}`] = pendingEntry({ entryId: `old-session-1-u${i}`, endedAt: T0 - (5 - i) * 60e3, turns: [{ a: '€'.repeat(100 * 1024) }] })
  }
  const r = rig(on, { env: URL_ENV, store })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await r.clock.advance(15000)
  await r.clock.settle()
  expect(pendingKeys(r.saved).sort()).toEqual(['pending:u2', 'pending:u3', 'pending:u4'])
  expect(totalBytes(r.saved)).toBeLessThanOrEqual(MIB)
})

test('a session that ends right after a commit reports the commit and its files', async ($, on) => {
  const g = { head: 'aaa1111', diff: {} as Record<string, string> }
  const r = rig(on, { git: g, env: { LUNA_JOURNAL_TOKEN: 'tok', ...URL_ENV } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await r.clock.settle()
  await $.turn.complete(turn('wrote the change'))
  await r.clock.settle()
  expect((r.saved.get('sess:s1-0000-session') as any).startSha).toBe('aaa1111')
  // The commit lands after the last turn, and the session ends at once.
  g.head = 'bbb2222'
  g.diff['aaa1111 HEAD'] = 'committed.ts\nalso.ts\n'
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1-0000-session', resume: { id: 's1-0000-session' } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await r.clock.advance(15000)
  await r.clock.settle()
  expect(r.fetches.length).toBe(1)
  const body = JSON.parse(r.fetches[0]!.init.body)
  expect(body.head_sha).toBe('bbb2222')
  expect(body.files_changed).toEqual(['committed.ts', 'also.ts'])
  // Read from the stored repo root, against the stored start commit.
  const diffRun = r.runs.find((x) => x.argv === 'git diff --name-only aaa1111 HEAD')
  expect(diffRun?.cwd).toBe('/r')
})
