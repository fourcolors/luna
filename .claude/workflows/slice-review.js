export const meta = {
  name: 'slice-review',
  description: 'Adversarial review of a diff: parallel reviewers by dimension, skeptics refute high-severity findings, then an adjudicated fix list',
  whenToUse: 'After building a slice (and again after applying fixes). Pass the intent + how to get the diff via args. For a second pass, also pass priorFindings to verify the fixes landed.',
  phases: [
    { title: 'Review', detail: 'parallel reviewers, one per dimension' },
    { title: 'Verify', detail: 'skeptics try to REFUTE each high-severity finding before it is reported' },
    { title: 'FixAudit', detail: 'optional: confirm prior findings were actually fixed (and introduced no regression)' },
    { title: 'Synthesize', detail: 'dedupe + adjudicate into must/should/wont-fix' },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// slice-review — generalized from the capability-catalog review run.
//
// WHAT CHANGED vs the original one-off (per the 2026-06-25 retro):
//  • ADVERSARIAL VERIFICATION (new Verify phase): every blocker/major finding is
//    handed to an independent skeptic prompted to REFUTE it, given the INTENT so
//    it can tell a deliberate choice from a bug. Refuted findings are dropped
//    before they reach the user. Catches plausible-but-wrong findings (e.g. the
//    "can a client interrupt arbitrary threads?" claim that needed a real check).
//  • FIX-VERIFICATION MODE (new optional FixAudit phase): pass args.priorFindings
//    (the must/should-fixes from a previous run) and the workflow audits the
//    PATCHED diff to confirm each was actually fixed and introduced no regression.
//    Fixes the original gap: the first run reviewed the code, then I changed it
//    and only re-ran unit tests — never re-reviewed the patched diff.
//  • Dimensions are caller-supplied via args (reusable), with secure-by-default
//    defaults (a dedicated security/trust-boundary lens). No inner backticks.
//
// INVOKE (first pass):
//   Workflow({ name: 'slice-review', args: {
//     intent:   'What the user set out to accomplish + the deliberate tradeoffs',
//     diffCmd:  'git diff --cached -- packages apps',   // how reviewers see the change
//     repoPath: '/abs/path/to/repo-or-worktree',
//     dimensions: [{ key, prompt }, ...],               // optional; overrides defaults
//   }})
// INVOKE (second pass, after applying fixes):
//   ...same args, plus priorFindings: [{ id, issue, fix }, ...]
// ─────────────────────────────────────────────────────────────────────────────

// Tolerate args arriving as a JSON STRING (a common invocation footgun — the
// Workflow tool wants a real JSON object; a stringified blob otherwise makes the
// whole script silently fall back to defaults). Parse it, then LOG the resolved
// config so a misconfigured run is observable instead of silently empty.
let a = args || {}
if (typeof a === 'string') { try { a = JSON.parse(a) } catch (e) { a = {} } }
const repoPath = a.repoPath || '.'
const diffCmd = a.diffCmd || 'git diff --cached'

const CTX = [
  'The changeset under review is EXACTLY the output of this command — run it FIRST and review only what it prints:\n    ' + diffCmd + '\n' +
  'The working tree may be clean BY DESIGN (e.g. reviewing an already-committed or merged change). Do NOT fall back to `git diff`, `git status`, or `git diff <branch>`. If that exact command prints nothing, say so explicitly instead of reporting "no changes". Read the changed files under ' + repoPath + ' for full context, and cite file:line.',
  a.intent ? 'INTENT (what the author set out to do + deliberate tradeoffs — do NOT flag these as mistakes):\n' + a.intent : '',
  'Be adversarial. Cite file + location. Give a concrete suggestedFix for each finding.',
].filter(Boolean).join('\n\n')

// ── Schemas ──────────────────────────────────────────────────────────────────
const FINDINGS = {
  type: 'object', additionalProperties: false, required: ['dimension', 'summary', 'findings'],
  properties: {
    dimension: { type: 'string' }, summary: { type: 'string' },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity', 'file', 'where', 'issue', 'suggestedFix'], properties: {
      severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
      file: { type: 'string' }, where: { type: 'string' }, issue: { type: 'string' }, suggestedFix: { type: 'string' },
    } } },
  },
}
const VERDICT = {
  type: 'object', additionalProperties: false, required: ['refuted', 'reason'],
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
}
const AUDIT = {
  type: 'object', additionalProperties: false, required: ['finding', 'status', 'evidence'],
  properties: {
    finding: { type: 'string' },
    status: { type: 'string', enum: ['fixed', 'partial', 'not-fixed', 'regressed'] },
    evidence: { type: 'string', description: 'file:line proof the fix is (or is not) present, and whether it regressed anything' },
  },
}
const SYNTH = {
  type: 'object', additionalProperties: false, required: ['mustFix', 'shouldFix', 'wontFix', 'verdict'],
  properties: {
    mustFix: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['file', 'where', 'issue', 'fix'], properties: { file: { type: 'string' }, where: { type: 'string' }, issue: { type: 'string' }, fix: { type: 'string' } } } },
    shouldFix: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['file', 'where', 'issue', 'fix'], properties: { file: { type: 'string' }, where: { type: 'string' }, issue: { type: 'string' }, fix: { type: 'string' } } } },
    wontFix: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string' },
  },
}

// ── Dimensions (override via args.dimensions) ────────────────────────────────
const defaultDimensions = [
  { key: 'correctness', prompt: 'Correctness + regressions: logic errors, broken edge cases, contract/shape drift across the layers, and anything the change breaks in adjacent code. Verify shared shapes match on both sides of every boundary.' },
  { key: 'security', prompt: 'Security + trust boundary: treat any external/untrusted input as hostile. Is it validated/decoded at the boundary before use/render? Authorization (can a caller act on resources it does not own?), injection, resource bounds (DoS), and privilege/collision shadowing. Flag real trust gaps with a concrete fix.' },
  { key: 'integration', prompt: 'Integration + state transitions: behavior across reconnects, swaps, lifecycle, and version skew (the seams unit tests miss). Does a gate/flag actually gate? Does stale state get cleared? Dangling timers/listeners/promises.' },
  { key: 'tests', prompt: 'Tests + maintainability: do the tests actually assert the risky behavior (not just the happy path)? Missing cases, drift risk in duplicated types, dead code, fragile coupling, and any silently-bounded coverage.' },
]
const dimensions = (a.dimensions && a.dimensions.length ? a.dimensions : defaultDimensions)

log('slice-review config — diffCmd=[' + diffCmd + '] dimensions=' + dimensions.length +
  ' priorFindings=' + (a.priorFindings || []).length + (a.intent ? ' intent=yes' : ' intent=NONE') +
  ((!a.diffCmd || !a.dimensions) ? ' (WARNING: some args fell back to defaults — was args passed as a real JSON object?)' : ''))

// ── Review → Verify (pipeline: each dimension verifies as soon as it returns) ─
phase('Review')
const reviewed = await pipeline(
  dimensions,
  (d) => agent(CTX + '\n\nDIMENSION: ' + d.prompt, { label: 'review:' + d.key, phase: 'Review', schema: FINDINGS, effort: 'high' }),
  async (review, d) => {
    const findings = (review && review.findings) || []
    const high = findings.filter((f) => f.severity === 'blocker' || f.severity === 'major')
    const low = findings.filter((f) => f.severity !== 'blocker' && f.severity !== 'major')
    const verdicts = (await parallel(high.map((f) => () =>
      agent(
        CTX + '\n\nA reviewer raised this ' + f.severity + ' finding:\n' + f.file + ' @ ' + f.where + '\nIssue: ' + f.issue +
        '\n\nTry to REFUTE it. Set refuted=true ONLY if you can show it is not a real problem here — wrong, already handled in the code, or a deliberate choice per the intent. If you are uncertain, refuted=false (keep it). Read the real code before deciding.',
        { label: 'verify:' + d.key, phase: 'Verify', schema: VERDICT, effort: 'high' }
      ).then((v) => ({ f: f, refuted: !!(v && v.refuted), reason: v && v.reason }))
    ))).filter(Boolean)
    const survivors = verdicts.filter((x) => !x.refuted).map((x) => Object.assign({ dimension: d.key }, x.f))
    const refuted = verdicts.filter((x) => x.refuted).map((x) => ({ file: x.f.file, issue: x.f.issue, reason: x.reason }))
    return { dimension: d.key, findings: [...survivors, ...low.map((f) => Object.assign({ dimension: d.key }, f))], refuted }
  }
)
const live = reviewed.filter(Boolean)
const findings = live.flatMap((r) => r.findings)
const refutedAll = live.flatMap((r) => r.refuted || [])
log('Review complete: ' + findings.length + ' findings kept, ' + refutedAll.length + ' refuted & dropped.')

// ── Optional FixAudit: confirm prior findings were actually fixed ────────────
let fixAudit = []
if ((a.priorFindings || []).length) {
  phase('FixAudit')
  fixAudit = (await parallel(a.priorFindings.map((pf, i) => () =>
    agent(
      CTX + '\n\nA prior review round asked for this fix:\nIssue: ' + (pf.issue || pf.id || ('finding ' + i)) +
      '\nIntended fix: ' + (pf.fix || '(unspecified)') +
      '\n\nAudit the changeset shown by the diff command above (and the files under ' + repoPath + '): is it actually fixed, and did the fix introduce any regression? Cite file:line evidence.',
      { label: 'fix-audit', phase: 'FixAudit', schema: AUDIT, effort: 'high' }
    )
  ))).filter(Boolean)
  const unresolved = fixAudit.filter((x) => x.status !== 'fixed').length
  log('Fix audit: ' + fixAudit.length + ' checked, ' + unresolved + ' not fully fixed.')
}

// ── Synthesize ───────────────────────────────────────────────────────────────
phase('Synthesize')
const ftxt = findings.map((f, i) => (i + 1) + '. [' + f.severity + '] (' + f.dimension + ') ' + f.file + ' @ ' + f.where + ': ' + f.issue + '\n   fix: ' + f.suggestedFix).join('\n')
const atxt = fixAudit.length ? '\n\nFix audit (prior findings):\n' + fixAudit.map((x) => '- [' + x.status + '] ' + x.finding + ' — ' + x.evidence).join('\n') : ''
const synth = await agent(
  CTX + '\n\nVerified findings (refuted ones already dropped):\n\n' + ftxt + atxt +
  '\n\nAdjudicate as a discerning lead. Produce mustFix (real defects, each with a concrete fix), shouldFix (worthwhile non-blocking + missing tests), wontFix (rejected/over-engineering, with a reason), and a one-line verdict on whether it is safe to ship. If a fix audit is present, any status other than fixed is at least a shouldFix.',
  { label: 'synth', phase: 'Synthesize', schema: SYNTH, effort: 'high' }
)

return { findings, refuted: refutedAll, fixAudit, synth }
