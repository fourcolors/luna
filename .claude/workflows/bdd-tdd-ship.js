export const meta = {
  name: 'bdd-tdd-ship',
  description: 'Behavior-first, test-first build loop: decompose intent into BDD scenarios, author proven-failing tests (RED), loop an implementer to GREEN with adversarial anti-gaming verification, then an adversarial change+blast-radius review. Returns a ship-readiness report; does NOT merge or release.',
  whenToUse: 'When you want a behavior-anchored, test-first implementation of a specific change IN A WORKTREE, validated by a red->green loop and an adversarial review, before the human-gated no-mistakes / merge / release steps. Pass intent, repoPath (a worktree), testCmd, and context via args.',
  phases: [
    { title: 'Intent', detail: 'parallel analysts decompose intent into BDD scenarios; a critic selects the behavior set' },
    { title: 'RedTests', detail: 'author the behaviors as tests in the real harness and prove they fail for the right reason' },
    { title: 'GreenLoop', detail: 'loop an implementer to all-green, then skeptics verify the green is real (not gamed)' },
    { title: 'Review', detail: 'delegate to slice-review: adversarial multi-dimension review of the change + blast radius' },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// bdd-tdd-ship — a reusable BDD/TDD build harness.
//
// Pipeline: understand intent -> behaviors (goals) -> proven-RED tests ->
// implement-to-GREEN loop (anti-gaming verified) -> adversarial review.
// It STOPS at a ship-readiness report. no-mistakes, merge, and cut-release are
// stateful / irreversible and stay in the main thread (per CLAUDE.md).
//
// WORKTREE DISCIPLINE: background subagents pin cwd to the MAIN checkout, so
// every mutating/test agent is told to use ABSOLUTE paths under repoPath and to
// prefix any shell with `cd <repoPath> &&`. Never edit outside repoPath.
//
// No inner backticks anywhere (string-concat + arrays) so the script parses.
//
// INVOKE:
//   Workflow({ name: 'bdd-tdd-ship', args: {
//     intent:   'What behavior to build + WHY + the deliberate tradeoffs',
//     context:  'Where the relevant code lives, the precedent to mirror, constraints, file:line anchors',
//     repoPath: '/abs/path/to/worktree',
//     testCmd:  'cd <repoPath> && npx vitest run apps/ui-moon-tauri',
//     maxGreenRounds: 4,        // optional loop bound
//     analystCount: 3,          // optional behavior-lens fan-out
//     model: 'sonnet',          // optional model for the CODING agents
//   }})
// ─────────────────────────────────────────────────────────────────────────────

const a = args || {}
const repoPath = a.repoPath || '.'
const testCmd = a.testCmd || ('cd ' + repoPath + ' && npx vitest run')
const maxGreenRounds = Math.max(1, a.maxGreenRounds || 4)
const analystCount = Math.max(1, Math.min(4, a.analystCount || 3))
const coder = a.model || 'sonnet'   // Sonnet codes; verifiers inherit the session model (Opus validates).

const CTX = [
  'INTENT (what we set out to build + why; do NOT flag deliberate tradeoffs as mistakes):\n' + (a.intent || 'See context below.'),
  a.context ? 'CONTEXT (where the relevant code lives, the precedent to mirror, constraints):\n' + a.context : '',
  'REPO / WORKTREE you operate on. Use ABSOLUTE paths under it. For ANY shell / git / test, prefix with:  cd ' + repoPath + ' &&  ... . Never read or edit files outside ' + repoPath + ':\n' + repoPath,
  'TEST COMMAND (run EXACTLY this to execute the relevant tests):\n    ' + testCmd,
  'Read REAL code and cite file:line. Mirror the existing test/code style in this repo.',
].filter(Boolean).join('\n\n')

// ── Schemas ──────────────────────────────────────────────────────────────────
const BITEM = {
  type: 'object', additionalProperties: false,
  required: ['id', 'title', 'given', 'when', 'then', 'testSurface', 'expectedInitial', 'priority', 'rationale'],
  properties: {
    id: { type: 'string' }, title: { type: 'string' },
    given: { type: 'string' }, when: { type: 'string' }, then: { type: 'string' },
    testSurface: { type: 'string', description: 'Exactly where/how to test this in the real harness: the file to create/extend, what to import or parse, and the concrete assertion. Prefer no running-app dependency (parse config, call pure functions).' },
    expectedInitial: { type: 'string', enum: ['red', 'green'], description: 'red = new behavior absent today (true TDD); green = regression guard that must already hold' },
    priority: { type: 'string', enum: ['core', 'guard', 'edge'] },
    rationale: { type: 'string' },
  },
}
const BEHAVIORS = { type: 'object', additionalProperties: false, required: ['behaviors'], properties: { behaviors: { type: 'array', items: BITEM } } }
const SELECT = {
  type: 'object', additionalProperties: false, required: ['behaviors', 'dropped', 'coverageNotes'],
  properties: {
    behaviors: { type: 'array', items: BITEM },
    dropped: { type: 'array', items: { type: 'string' } },
    coverageNotes: { type: 'string', description: 'What is covered, what is deliberately out of scope, and any behavior that can only be proven in a running app (flag integration-only).' },
  },
}
const RED = {
  type: 'object', additionalProperties: false, required: ['testFiles', 'ran', 'results', 'redProven', 'output', 'summary'],
  properties: {
    testFiles: { type: 'array', items: { type: 'string' } },
    ran: { type: 'boolean' },
    results: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['behaviorId', 'testName', 'passed'], properties: { behaviorId: { type: 'string' }, testName: { type: 'string' }, passed: { type: 'boolean' } } } },
    redProven: { type: 'boolean', description: 'true iff every expectedInitial=red behavior has a test that currently FAILS, and every expectedInitial=green guard PASSES' },
    output: { type: 'string', description: 'tail of the runner output (~2000 chars), keeping the failing assertions' },
    summary: { type: 'string' },
  },
}
const REDVERDICT = {
  type: 'object', additionalProperties: false, required: ['valid', 'reason'],
  properties: {
    valid: { type: 'boolean', description: 'true iff the RED is genuine: the red tests fail because the behavior is truly absent (NOT a typo / missing import / tautological assertion) and each test exercises the behavior at the right surface' },
    reason: { type: 'string' },
    concerns: { type: 'array', items: { type: 'string' } },
  },
}
const IMPL = {
  type: 'object', additionalProperties: false, required: ['allGreen', 'filesChanged', 'output', 'summary'],
  properties: {
    allGreen: { type: 'boolean' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    output: { type: 'string', description: 'tail of the FULL test command output (~2000 chars)' },
    summary: { type: 'string', description: 'what production change made the tests pass' },
  },
}
const GREENVERDICT = {
  type: 'object', additionalProperties: false, required: ['realGreen', 'reason'],
  properties: {
    realGreen: { type: 'boolean', description: 'false if green was gamed: tests weakened/skipped/deleted, assertions gutted, the implementation hard-codes or special-cases the test inputs instead of fixing the behavior, or the fix is wrong / over-broad' },
    reason: { type: 'string' },
    requiredFixes: { type: 'array', items: { type: 'string' } },
  },
}

// ── Phase 1: Intent -> Behaviors (goals) ─────────────────────────────────────
phase('Intent')
const LENSES = [
  'Contract lens: decompose the intent into the SMALLEST set of behaviors that fully pin the user-visible contract. For each, give Given/When/Then plus the exact test surface. Favor behaviors testable WITHOUT a running app (parse config / call pure functions).',
  'Adversary lens: enumerate the regressions and failure modes this change could introduce, or that a naive fix would miss (e.g. an over-broad grant, the existing/singleton path breaking, an out-of-scope case still being allowed). Turn each into a guard behavior.',
  'Boundary lens: the invariants and edge cases at the trust / security boundary this change touches. What must ALWAYS hold regardless of inputs? Turn each invariant into a property-style guard behavior.',
  'Coverage lens: what would a reviewer say is MISSING from a test suite for this change? Name the under-tested seams and turn them into behaviors.',
].slice(0, analystCount)

const proposed = (await parallel(LENSES.map((p, i) => () =>
  agent(CTX + '\n\nYOUR LENS:\n' + p, { label: 'behaviors:' + (i + 1), phase: 'Intent', schema: BEHAVIORS, model: coder, effort: 'high' })
))).filter(Boolean)
const allBehaviors = proposed.flatMap((p) => p.behaviors || [])
log('Behavior candidates: ' + allBehaviors.length + ' from ' + proposed.length + ' lenses.')

const btxt = allBehaviors.map((b, i) => (i + 1) + '. [' + b.expectedInitial + '/' + b.priority + '] ' + b.title + '\n   Given ' + b.given + '\n   When ' + b.when + '\n   Then ' + b.then + '\n   surface: ' + b.testSurface).join('\n')
const selection = await agent(
  CTX + '\n\nProposed behaviors from multiple lenses (deduplicate, merge near-duplicates, drop the redundant / over-engineered):\n\n' + btxt +
  '\n\nSelect the behavior set that will DRIVE this build. Keep the core behaviors (the new contract) and the highest-value guards; drop redundancy. At least one expectedInitial=red behavior MUST capture the NEW functionality, or this is not test-first. Flag any behavior that can only be proven in a running app as integration-only in coverageNotes (do not let it block the unit loop).',
  { label: 'select-behaviors', phase: 'Intent', schema: SELECT, effort: 'high' }
)
const behaviors = (selection && selection.behaviors && selection.behaviors.length) ? selection.behaviors : allBehaviors
const redCount = behaviors.filter((b) => b.expectedInitial === 'red').length
log('Behaviors selected: ' + behaviors.length + ' (' + redCount + ' red / ' + (behaviors.length - redCount) + ' guard). ' + ((selection && selection.coverageNotes) || ''))

// ── Phase 2: RedTests — author the failing tests and prove the red is real ───
phase('RedTests')
const behaviorsText = behaviors.map((b) => '- [' + b.id + '][' + b.expectedInitial + '] ' + b.title + '\n    Given ' + b.given + '\n    When ' + b.when + '\n    Then ' + b.then + '\n    Test surface: ' + b.testSurface).join('\n')
const redInstr = CTX +
  '\n\nAuthor these behaviors as tests IN THE REAL HARNESS (a single cohesive test file is fine; mirror the existing test style in this repo). Each behavior becomes a clearly-named test whose name traces to its behavior id and reads as Given/When/Then. Do NOT implement the production change yet.\n\nBEHAVIORS:\n' + behaviorsText +
  '\n\nThen RUN the test command and report per-behavior pass/fail. EXPECTED: every [red] behavior FAILS now (the behavior is absent), every [green] guard PASSES. Set redProven=true ONLY if that holds. If a [red] test unexpectedly passes, the test is too weak - strengthen it. Truncate output to ~2000 chars, keeping the failing assertions.'
let red = await agent(redInstr, { label: 'author-red', phase: 'RedTests', model: coder, effort: 'high', schema: RED })

let redCheck = await agent(
  CTX + '\n\nAn engineer authored failing tests for the behaviors and reports redProven=' + (red && red.redProven) + '.\nFiles: ' + ((red && red.testFiles) || []).join(', ') + '\nRun output tail:\n' + ((red && red.output) || '(none)') +
  '\n\nRead the ACTUAL test file(s) under ' + repoPath + '. Verify the RED is genuine: the [red] tests fail because the behavior is truly absent (NOT a typo, missing import, or a tautological / trivially-false assertion), and each test exercises the behavior at the right surface per its Given/When/Then. Set valid=true only if the red is real and the tests are meaningful.',
  { label: 'verify-red', phase: 'RedTests', schema: REDVERDICT, effort: 'high' }
)
// One bounded repair pass if the red is not credible.
if (redCheck && redCheck.valid === false) {
  log('RED rejected by verifier: ' + redCheck.reason + ' - one repair pass.')
  red = await agent(
    redInstr + '\n\nA reviewer REJECTED the first attempt as not-credible-red for these reasons:\n- ' + ([redCheck.reason].concat(redCheck.concerns || [])).join('\n- ') + '\nFix the tests so the red is genuine and meaningful, re-run, and report.',
    { label: 'author-red:repair', phase: 'RedTests', model: coder, effort: 'high', schema: RED }
  )
  redCheck = await agent(
    CTX + '\n\nRe-verify the repaired tests under ' + repoPath + ' (files: ' + ((red && red.testFiles) || []).join(', ') + '). Output tail:\n' + ((red && red.output) || '(none)') + '\n\nIs the RED now genuine and meaningful? Set valid accordingly.',
    { label: 'verify-red:2', phase: 'RedTests', schema: REDVERDICT, effort: 'high' }
  )
}
log('RED: redProven=' + (red && red.redProven) + ', verifier valid=' + (redCheck && redCheck.valid) + '. Files: ' + ((red && red.testFiles) || []).join(', '))

// ── Phase 3: GreenLoop — implement to green, then verify the green is real ───
phase('GreenLoop')
let impl = null
let greenVerdict = null
let lastOutput = (red && red.output) || ''
let round = 0
while (round < maxGreenRounds) {
  round++
  impl = await agent(
    CTX + '\n\nThe failing tests encode the target behavior. Make the MINIMAL production change to make the FULL test command pass. Rules: do NOT weaken, skip, or delete any test; do NOT special-case or hard-code the test inputs - fix the REAL behavior; keep the change least-privilege (grant/expose no more than the behavior requires). ' +
    (round > 1 ? 'A PREVIOUS attempt did not satisfy the gate. Latest feedback / output tail:\n' + lastOutput + '\n' : '') +
    'After changing code, RUN the test command and report. Set allGreen=true only if the entire command passes with 0 failures.',
    { label: 'implement:r' + round, phase: 'GreenLoop', model: coder, effort: 'high', schema: IMPL }
  )
  lastOutput = (impl && impl.output) || lastOutput
  log('Green round ' + round + ': allGreen=' + (impl && impl.allGreen) + ' [' + ((impl && impl.filesChanged) || []).join(', ') + ']')
  if (!impl || !impl.allGreen) continue

  // Anti-gaming gate: 3 skeptics independently try to prove the green is fake.
  const skeptics = (await parallel([0, 1, 2].map((k) => () =>
    agent(
      CTX + '\n\nThe implementer reports ALL TESTS GREEN. Files changed: ' + ((impl && impl.filesChanged) || []).join(', ') + '.\n' +
      'Skeptic ' + (k + 1) + ' of 3 - try to prove the green is FAKE. Read the test file(s) AND the production change under ' + repoPath + ', and RE-RUN the test command yourself. Green is FAKE if any of: a test was weakened / skipped / deleted, an assertion was gutted, the implementation hard-codes or special-cases the test inputs instead of fixing the behavior, the fix is wrong or OVER-BROAD (grants/exposes more than the behavior needs), or a [red] test now passes for the wrong reason. Set realGreen=false if you find ANY such gaming, and list requiredFixes.',
      { label: 'green-skeptic:r' + round + '.' + (k + 1), phase: 'GreenLoop', schema: GREENVERDICT, effort: 'high' }
    )
  ))).filter(Boolean)
  const fakes = skeptics.filter((s) => !s.realGreen)
  if (fakes.length < 2) {   // majority of 3 confirm honest green
    greenVerdict = { realGreen: true, reason: 'Majority of skeptics confirmed honest green.', dissent: fakes.map((f) => f.reason), skeptics }
    break
  }
  greenVerdict = { realGreen: false, reason: fakes.map((f) => f.reason).join(' | '), skeptics }
  lastOutput = 'Skeptics rejected the green as gamed. Required fixes:\n- ' + fakes.flatMap((f) => (f.requiredFixes && f.requiredFixes.length) ? f.requiredFixes : [f.reason]).join('\n- ')
  log('Green round ' + round + ' REJECTED by ' + fakes.length + '/' + skeptics.length + ' skeptics; looping.')
}
const shipped = !!(greenVerdict && greenVerdict.realGreen)
log(shipped ? 'GREEN verified real after ' + round + ' round(s).' : 'Did NOT reach verified-green in ' + maxGreenRounds + ' rounds.')

// ── Phase 4: Review — delegate to the existing adversarial slice-review ───────
phase('Review')
const diffCmd = 'cd ' + repoPath + ' && git add -A >/dev/null 2>&1 && git --no-pager diff --cached master -- apps packages'
const sliceReviewRef = a.sliceReviewPath ? { scriptPath: a.sliceReviewPath } : 'slice-review'
let review = null
try {
  review = await workflow(sliceReviewRef, { intent: a.intent, diffCmd: diffCmd, repoPath: repoPath })
} catch (e) {
  log('slice-review delegation unavailable (' + String(e) + '); running an inline review instead.')
  review = await agent(
    CTX + '\n\nReview the change shown by:  ' + diffCmd + '\nacross correctness, security / trust-boundary, integration, and tests. Be adversarial; cite file:line; give concrete fixes. Flag any over-broad grant, regression, or missing test.',
    { label: 'review-fallback', phase: 'Review', effort: 'high' }
  )
}

return {
  behaviors,
  coverageNotes: selection && selection.coverageNotes,
  red: { redProven: red && red.redProven, testFiles: (red && red.testFiles) || [], verifierValid: redCheck && redCheck.valid },
  green: { shipped, rounds: round, summary: impl && impl.summary, filesChanged: (impl && impl.filesChanged) || [], verdict: greenVerdict },
  review,
}
