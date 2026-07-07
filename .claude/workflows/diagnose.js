export const meta = {
  name: 'diagnose',
  description: 'Parallel root-cause diagnosis of a set of failing tests / issues: one read-only diagnoser per target observes the failure, classifies it (real bug / flaky / stale artifact / env), and returns a concrete fix spec. A synthesizer suggests PR grouping. Read-only - it does NOT apply fixes.',
  whenToUse: 'When you have N independent failing tests or issues and want each root-caused + a fix spec in parallel before you implement. Pass repoPath, context, testCmd, and targets[] via args. Implement the fixes yourself afterward (the edit->verify loop belongs in the main thread).',
  phases: [
    { title: 'Diagnose', detail: 'one read-only diagnoser per target: observe, root-cause, classify, spec the fix' },
    { title: 'Synthesize', detail: 'group into PRs, flag risk + shared root causes' },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// diagnose — parallel read-only root-cause fan-out.
//
// Each diagnoser is READ-ONLY (Explore agent): it reads the failing test + the
// code under test, RUNS the failing test to observe the real failure, decides
// whether it is a genuine bug or flaky/stale/env, and writes a concrete fix
// spec (files + change + verify command). It does not edit anything, so the
// background-subagent cwd-trap cannot cause damage. The main thread implements.
//
// No inner backticks (string-concat) so the script parses.
//
// INVOKE:
//   Workflow({ name: 'diagnose', args: {
//     repoPath: '/abs/path/to/worktree',
//     context:  'Shared background a diagnoser needs (recent change, harness, conventions)',
//     testCmd:  'cd <repoPath> && npx vitest run',  // how to run a target test
//     targets: [{ key: 'moon-vendor', prompt: 'Diagnose <failing test> ...' }, ...],
//   }})
// ─────────────────────────────────────────────────────────────────────────────

const a = args || {}
const repoPath = a.repoPath || '.'
const targets = (a.targets && a.targets.length) ? a.targets : []

const PRE = [
  a.context ? 'CONTEXT:\n' + a.context : '',
  'REPO / WORKTREE to read + run tests in (use ABSOLUTE paths under it; for any shell/test, prefix with: cd ' + repoPath + ' && ...):\n' + repoPath,
  a.testCmd ? 'To OBSERVE a failure, run the relevant test, e.g.:\n    ' + a.testCmd : '',
  'You are DIAGNOSING only - do NOT edit any files. Read the real code, RUN the failing test to see the actual error, cite file:line.',
].filter(Boolean).join('\n\n')

const DIAG = {
  type: 'object', additionalProperties: false,
  required: ['target', 'summary', 'rootCause', 'classification', 'confidence', 'fixSpec', 'filesToTouch', 'verifyCmd', 'risks'],
  properties: {
    target: { type: 'string' },
    summary: { type: 'string' },
    rootCause: { type: 'string', description: 'The actual mechanism, with file:line anchors and the observed error' },
    classification: { type: 'string', enum: ['real-bug', 'flaky', 'stale-artifact', 'env', 'unknown'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    fixSpec: { type: 'string', description: 'A concrete, minimal fix: exactly what to change and why. If flaky/env, how to make it deterministic instead of masking it.' },
    filesToTouch: { type: 'array', items: { type: 'string' } },
    verifyCmd: { type: 'string', description: 'The exact command that should pass after the fix' },
    risks: { type: 'array', items: { type: 'string' } },
  },
}
const SYNTH = {
  type: 'object', additionalProperties: false, required: ['grouping', 'sharedRootCauses', 'order', 'notes'],
  properties: {
    grouping: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['pr', 'targets', 'rationale'], properties: { pr: { type: 'string' }, targets: { type: 'array', items: { type: 'string' } }, rationale: { type: 'string' } } } },
    sharedRootCauses: { type: 'array', items: { type: 'string' } },
    order: { type: 'array', items: { type: 'string', description: 'target keys in the order they should be fixed' } },
    notes: { type: 'string' },
  },
}

phase('Diagnose')
const diags = (await parallel(targets.map((t) => () =>
  agent(PRE + '\n\nYOUR TARGET (' + t.key + '):\n' + t.prompt, { label: 'diagnose:' + t.key, phase: 'Diagnose', agentType: 'Explore', schema: DIAG, effort: 'high' })
))).filter(Boolean)
log('Diagnosed ' + diags.length + '/' + targets.length + ' targets.')

phase('Synthesize')
const dtxt = diags.map((d) => '### ' + d.target + ' [' + d.classification + '/' + d.confidence + ']\n' + d.summary + '\nRoot cause: ' + d.rootCause + '\nFix: ' + d.fixSpec + '\nFiles: ' + (d.filesToTouch || []).join(', ') + '\nVerify: ' + d.verifyCmd).join('\n\n---\n\n')
const synth = await agent(
  PRE + '\n\nDiagnoses:\n\n' + dtxt + '\n\nAs the lead: group these into the RIGHT number of PRs (a trivial generated-artifact sync should not be bundled with a substantive logic fix unless they share a root cause; genuinely independent fixes can share one hygiene PR if all are small + low-risk). Give the fix order, any shared root cause, and risks. Keep it tight.',
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH, effort: 'high' }
)

return { diagnoses: diags, synthesis: synth }
