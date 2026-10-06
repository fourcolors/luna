import { expect, mock, test } from 'claude-code/testing'
import {
  buildBody,
  clampSummary,
  cleanFiles,
  makeEntryId,
  porcelainPaths,
  redact,
} from '../hooks/lib.js'

const HOUR = 3600e3
const T0 = Date.parse('2026-10-06T10:00:00Z')
const SECRET = 'sk-ant-' + 'A'.repeat(24)

type Opts = {
  env?: Record<string, string>
  store?: Record<string, unknown>
  fetchStatus?: number[]
  fetchThrows?: boolean
  model?: 'ok' | 'unanswered' | 'throws'
  now?: number
}

// Registers every stub the mod needs. Must run before the test's first $ call.
function rig(on: any, o: Opts = {}) {
  const saved = new Map<string, unknown>(Object.entries(o.store ?? {}))
  const fetches: Array<{ url: string; init: any }> = []
  const modelCalls: unknown[] = []
  const statuses = [...(o.fetchStatus ?? [200])]
  const clock = mock.clock(on, { now: o.now ?? T0 })
  mock.env(on, o.env ?? {})
  on('store.get', ($: any, e: any) => ({ value: saved.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    saved.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', ($: any, e: any) => {
    saved.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...saved.keys()] }))
  on('session.id', () => ({ value: 's1-0000-session' }))
  on('session.cwd', () => ({ value: '/r' }))
  on('session.repo', () => ({ value: { root: '/r', name: 'r', remote: null, internal: false } }))
  on('session.version', () => ({ value: { version: '2.1.291' } }))
  on('process.run', ($: any, e: any) => {
    const a = e.argv.join(' ')
    if (a === 'git branch --show-current') return { value: { exitCode: 0, stdout: 'main\n', stderr: '' } }
    if (a === 'git rev-parse HEAD') return { value: { exitCode: 0, stdout: 'abc1234def5678\n', stderr: '' } }
    if (a === 'hostname -s') return { value: { exitCode: 0, stdout: 'testmac\n', stderr: '' } }
    if (e.argv[0] === 'git') return { value: { exitCode: 0, stdout: '', stderr: '' } }
    return { value: { exitCode: 1, stdout: '', stderr: 'not found' } }
  })
  on('model.complete', ($: any, e: any) => {
    modelCalls.push(e)
    if (o.model === 'throws') return { deny: 'model not allowed' }
    if (o.model === 'unanswered') {
      return { value: { isAnswered: false, reason: 'api-error', usage: null } }
    }
    return { value: { isAnswered: true, text: 'Did X.\nChanged Y.', usage: null } }
  })
  on('http.fetch', ($: any, e: any) => {
    fetches.push({ url: e.url, init: e.init })
    if (o.fetchThrows) return { deny: 'connection refused' }
    const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!
    return { value: { status, ok: status >= 200 && status < 300, headers: {}, text: '{}' } }
  })
  on('session.start', () => ({ cwd: '/r' }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', ($: any, e: any) => ({ sessionId: e.sessionId }))
  on('tool.call', ($: any, e: any) => (e.tool === 'Write' ? { deny: 'no' } : { result: 'ok' }))
  return { saved, fetches, modelCalls, clock }
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
  const r = rig(on, { fetchStatus: [503, 200], env: { LUNA_JOURNAL_TOKEN: 'tok', LUNA_JOURNAL_URL: 'http://luna.test/v1/journal' }, store: { 'pending:e1': pendingEntry() } })
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
  expect(log.some((l) => l.what.startsWith('rejected') && l.err.startsWith('422'))).toBe(true)
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
  expect((r.saved.get('log') as any[]).some((l) => l.what.startsWith('drop'))).toBe(true)
})

test('no token: nothing is sent, the entry is kept and the gap is logged', async ($, on) => {
  const r = rig(on, { env: { LUNA_JOURNAL_URL: 'http://luna.test/v1/journal' }, store: { 'pending:e1': pendingEntry() } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await r.clock.advance(15000)
  await r.clock.settle()
  expect(r.fetches.length).toBe(0)
  expect(r.saved.has('pending:e1')).toBe(true)
  expect((r.saved.get('log') as any[]).some((l) => l.what === 'config')).toBe(true)
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
  expect(p.entryId).toMatch(/^old-session-1-cr[0-9a-z]+$/)
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
    'password=hunter2hunter2',
    'Q'.repeat(50),
  ]
  for (const s of samples) expect(redact('x ' + s + ' y')).toBe('x [REDACTED] y')
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
  expect(clampSummary('token: ' + 'z'.repeat(20))).toBe('[REDACTED]')
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
  expect(makeEntryId('s1', 1000)).toMatch(/^s1-session-[0-9a-z]+$/)
})
