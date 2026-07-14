export const meta = {
  name: 'design-sprint',
  description: 'JTBD + thoughtbot-style product design sprint: ground a design problem in Jobs-to-be-Done forces plus real technical/competitive research, diverge N concepts, converge on one build spec, hand off a prototype, then stress-test it with blind usability critique.',
  whenToUse: 'Before designing a non-trivial UI/UX surface where the right shape is genuinely uncertain and a fast build risks solving the wrong job. Pass the problem brief, any stakeholder evidence you already have, and repo context via args. Do NOT use this for a well-understood, low-stakes UI tweak - it is deliberately heavier than slice-research.',
  phases: [
    { title: 'Understand', detail: 'JTBD Four Forces from supplied evidence + parallel technical/competitive research' },
    { title: 'Diverge', detail: 'N concept designs against distinct lenses (default 3)' },
    { title: 'Converge', detail: 'critique matrix across concepts, one chosen/merged build spec, assumptions table, state machine' },
    { title: 'Prototype', detail: 'spec-only handoff by default; optionally delegates a real build if repoPath + fidelity=\'delegate-build\' are given' },
    { title: 'Test', detail: 'blind, task-based critique personas + a heuristic audit, ranked findings, plus a stakeholder test plan' },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// design-sprint - extracted from a real run (2026-07-14, Moon memory-browser
// panel), NOT written speculatively first. thoughtbot's own Product Design
// Sprint (design.thoughtbot.com/sprint-guide; github.com/thoughtbot/design-sprint,
// archived) already requires a Job-to-be-Done statement before day one - JTBD
// and the 5-phase sprint (Understand/Diverge/Converge/Prototype/Test) are not
// competing frameworks, JTBD is the sprint's own entry gate. This script fuses
// them: Understand does double duty as the JTBD Four-Forces analysis (Push,
// Pull, Anxiety, Habit - see jobstobedone.org) AND the technical/competitive
// research slice-research.js would call "Map".
//
// HONESTY NOTE: this script has been run ONCE, by hand, turn-by-turn via a
// plain Agent/Task tool (no Workflow-tool access in that thread) - the prompts
// and phase boundaries below are a faithful extraction of what actually
// worked, but the script ITSELF has not yet been executed end-to-end through
// the real Workflow tool. Treat the first live invocation as a shakedown run;
// if the SDK's agent()/parallel()/phase() plumbing behaves differently than
// assumed here, fix forward and update this comment.
//
// A NOTE ON "TEST": for a single-stakeholder tool, there usually is no real
// user panel. Test-phase agents are blind CODE-TRACE critics (cognitive
// walkthrough, Nielsen heuristics, a stakeholder-grounded skeptic persona) -
// they read a prototype/spec and simulate; they do NOT perceive real pixels
// or real latency. Say so plainly in the output. The actual ground truth is
// the stakeholder's own first real usage - this script emits a
// stakeholderTestPlan (pre-registered watch-fors) for exactly that reason.
// Testers get ONLY the prototype/spec + a task, NEVER the JTBD writeup or the
// Converge rationale - otherwise they parrot your reasoning back at you.
//
// No inner backticks anywhere (string-concat + arrays) so the script parses.
//
// INVOKE:
//   Workflow({ name: 'design-sprint', args: {
//     brief:     'What we are designing and for whom, in one paragraph.',
//     evidence:  'Direct quotes, prior incidents, documented behavior patterns -
//                 the raw material for JTBD forces. Cite sources inline.',
//     repoPath:  '/abs/path/to/repo-or-worktree',   // optional but recommended
//     constraints: 'Hard technical/product constraints the design must respect.',
//     researchers: [{ label, prompt }, ...],          // optional; overrides research areas
//     conceptLenses: [{ label, prompt }, ...],       // optional; overrides defaults
//     conceptCount: 3,                                // optional; ignored if conceptLenses given
//     fidelity: 'spec-only',                          // 'spec-only' | 'delegate-build'
//     testers: [{ label, prompt }, ...],              // optional; overrides test personas
//     stakeholderAnswers: 'Answers to prior questionsForStakeholder, if re-running.',
//     model: 'sonnet',
//   }})
// ─────────────────────────────────────────────────────────────────────────────

let a = args || {}
if (typeof a === 'string') { try { a = JSON.parse(a) } catch (e) { a = {} } }
const repoPath = a.repoPath || '.'
const model = a.model || 'sonnet'
const fidelity = a.fidelity === 'delegate-build' ? 'delegate-build' : 'spec-only'

const BRIEF = [
  a.brief || 'Design the surface described below.',
  a.constraints ? 'CONSTRAINTS:\n' + a.constraints : '',
  a.evidence ? 'STAKEHOLDER EVIDENCE (ground every JTBD force in this, label confidence, do not invent quotes):\n' + a.evidence : 'No stakeholder evidence was supplied - label every force LOW/INFERRED and lean on the questionsForStakeholder output instead of guessing.',
  a.stakeholderAnswers ? 'STAKEHOLDER ANSWERS from a prior run (treat as ground truth, supersedes any earlier inference):\n' + a.stakeholderAnswers : '',
  repoPath !== '.' ? 'Repo/worktree to research: ' + repoPath + '. Read REAL code and cite file:line, do not guess at APIs.' : '',
].filter(Boolean).join('\n\n')

// ── Schemas ──────────────────────────────────────────────────────────────────
const FORCES = {
  type: 'object', additionalProperties: false,
  required: ['push', 'pull', 'anxiety', 'habit', 'jobStatement', 'riskiestAssumption', 'questionsForStakeholder'],
  properties: {
    push: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['claim', 'evidence', 'confidence'], properties: { claim: { type: 'string' }, evidence: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low', 'inferred'] } } } },
    pull: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['claim', 'evidence', 'confidence'], properties: { claim: { type: 'string' }, evidence: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low', 'inferred'] } } } },
    anxiety: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['claim', 'evidence', 'confidence'], properties: { claim: { type: 'string' }, evidence: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low', 'inferred'] } } } },
    habit: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['claim', 'evidence', 'confidence'], properties: { claim: { type: 'string' }, evidence: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low', 'inferred'] } } } },
    jobStatement: { type: 'string', description: 'When [situation], [who] wants to [motivation], so they can [outcome]. Plus 1-2 alternates if the evidence genuinely supports more than one framing.' },
    riskiestAssumption: { type: 'object', additionalProperties: false, required: ['assumption', 'confidence', 'reasoning'], properties: { assumption: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, reasoning: { type: 'string' } } },
    questionsForStakeholder: { type: 'array', items: { type: 'string', description: 'A single compressed switch-interview-style question, answerable in one sentence, that would most cheaply resolve remaining uncertainty.' } },
  },
}
const RESEARCH = {
  type: 'object', additionalProperties: false,
  required: ['area', 'summary', 'keyFacts', 'recommendation', 'ruleOut'],
  properties: {
    area: { type: 'string' }, summary: { type: 'string' },
    keyFacts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['fact', 'source'], properties: { fact: { type: 'string' }, source: { type: 'string', description: 'file:line, URL, or "inferred"' } } } },
    recommendation: { type: 'string', description: 'What this research implies the design should do' },
    ruleOut: { type: 'array', items: { type: 'string', description: 'Approaches this research says NOT to pursue, and why - saves a Diverge slot' } },
  },
}
const CONCEPT = {
  type: 'object', additionalProperties: false,
  required: ['name', 'lens', 'layout', 'states', 'informationArchitecture', 'jtbdFit', 'weaknesses', 'verdict'],
  properties: {
    name: { type: 'string' }, lens: { type: 'string' },
    layout: { type: 'string', description: 'Concrete enough that an implementer does not have to guess' },
    states: { type: 'array', items: { type: 'string', description: 'One named interaction state, e.g. "empty", "loading", "delete-confirm"' } },
    informationArchitecture: { type: 'string' },
    jtbdFit: { type: 'object', additionalProperties: false, required: ['maximizes', 'defuses', 'doesNotSolve'], properties: { maximizes: { type: 'string' }, defuses: { type: 'string' }, doesNotSolve: { type: 'string', description: 'Honest - what this concept is bad at' } } },
    weaknesses: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string', description: 'One paragraph: would the stakeholder reach for this over the status quo, and when would they not' },
  },
}
const CONVERGE = {
  type: 'object', additionalProperties: false,
  required: ['chosenApproach', 'rationale', 'buildSpec', 'stateMachine', 'assumptionsTable', 'cutFromV1', 'openDecisionsForStakeholder'],
  properties: {
    chosenApproach: { type: 'string', description: 'Name the winning concept OR describe the merge across concepts' },
    rationale: { type: 'string' },
    buildSpec: { type: 'string', description: 'A concrete, implementable spec: layout, interaction model, information architecture, with file:line anchors where relevant. Detailed enough to hand to an implementer with no follow-up questions.' },
    stateMachine: { type: 'array', items: { type: 'string' } },
    assumptionsTable: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['assumption', 'confidence', 'evidence'], properties: { assumption: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, evidence: { type: 'string' } } } },
    cutFromV1: { type: 'array', items: { type: 'string', description: 'What was deliberately left out and why (usually: needs new backend/infra not yet justified)' } },
    openDecisionsForStakeholder: { type: 'array', items: { type: 'string' } },
  },
}
const PROTOTYPE = {
  type: 'object', additionalProperties: false,
  required: ['delivered', 'summary', 'artifactLocation', 'testResults'],
  properties: {
    delivered: { type: 'string', enum: ['spec-only', 'built'] },
    summary: { type: 'string' },
    artifactLocation: { type: 'string', description: 'File path, PR URL, or "N/A - spec only, hand to the invoking thread to build"' },
    testResults: { type: 'string', description: 'If built: actual test command + pass/fail counts. If spec-only: "N/A"' },
  },
}
const TESTFINDING = {
  type: 'object', additionalProperties: false,
  required: ['persona', 'transcript', 'topProblems', 'cannotVerifyFromSpecAlone'],
  properties: {
    persona: { type: 'string' },
    transcript: { type: 'string', description: 'Step-by-step: what the tester did, what happened, where they hesitated. Negative-finding mandate - report friction, do not cheerlead.' },
    topProblems: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['problem', 'severity', 'evidence'], properties: { problem: { type: 'string' }, severity: { type: 'string', enum: ['high', 'medium', 'low'] }, evidence: { type: 'string' } } } },
    cannotVerifyFromSpecAlone: { type: 'array', items: { type: 'string', description: 'Visual/perceptual/latency questions a code-trace genuinely cannot answer' } },
  },
}

// ── Phase 1: Understand - JTBD forces + parallel technical/competitive research
phase('Understand')
const forces = await agent(
  BRIEF + '\n\nProduce a rigorous JTBD Four Forces analysis (Push, Pull, Anxiety, Habit - the switch-interview framework: someone adopts a new solution only when Push+Pull > Anxiety+Habit against their current behavior). Ground every force in the supplied evidence, label confidence honestly, and do not pad with generic UX platitudes. Name the single riskiest unexamined assumption and provide 1-3 concise questions that would most cheaply resolve the remaining uncertainty.',
  { label: 'jtbd-forces', phase: 'Understand', schema: FORCES, model: model, effort: 'high' }
)
log('JTBD job statement: ' + ((forces && forces.jobStatement) || '(none)') + ' | riskiest assumption: ' + ((forces && forces.riskiestAssumption && forces.riskiestAssumption.assumption) || '(none)'))

const defaultResearch = [
  { label: 'technical-seams', prompt: 'Map the REAL technical surface this design must respect: existing data models, APIs/tools, constraints, and precedent to mirror. Read real code and cite file:line. Do not assume a capability exists - verify it.' },
  { label: 'competitive-scan', prompt: 'Research (web search + domain knowledge) 4-6 comparable products/patterns relevant to this problem. For each: what it does well, what would NOT translate here, and why. Synthesize which 2-3 patterns are worth stealing and which are clearly the wrong fit (rule them out explicitly so Diverge does not waste a slot re-deriving that).' },
]
const researchTasks = (a.researchers && a.researchers.length ? a.researchers : defaultResearch)
const research = (await parallel(researchTasks.map((r) => () =>
  agent(BRIEF + '\n\nYOUR AREA:\n' + r.prompt, { label: r.label, phase: 'Understand', schema: RESEARCH, model: model, effort: 'medium' })
))).filter(Boolean)
const researchDigest = research.map((r) => '## ' + r.area + '\n' + r.summary + '\nKey facts: ' + (r.keyFacts || []).map((k) => k.fact + ' (' + k.source + ')').join('; ') + '\nRecommendation: ' + r.recommendation + '\nRule out: ' + (r.ruleOut || []).join('; ')).join('\n\n---\n\n')
log('Research complete (' + research.length + ' areas). Diverging.')

// ── Phase 2: Diverge - N concept designs against distinct lenses ─────────────
phase('Diverge')
const N = Math.max(1, Math.min(4, a.conceptCount || 3))
const defaultLenses = [
  { label: 'concept:simplicity', prompt: 'Design the SIMPLEST version that serves the primary job with zero ceremony. Optimize for speed of the single most common interaction, even if it handles scale/volume poorly - name that tradeoff honestly.' },
  { label: 'concept:scale', prompt: 'Design for the case where this is used systematically/repeatedly at volume (batch review, structured audit), even if it is heavier for a one-off use. Optimize for throughput and structure over minimalism.' },
  { label: 'concept:entry-point', prompt: 'Design around the SPECIFIC MOMENT the stakeholder actually reaches for this (per the JTBD job statement), not a generic browse experience. What does the ideal cold-start / entry interaction look like for that exact trigger?' },
  { label: 'concept:wildcard', prompt: 'Propose the least obvious viable approach - one the other lenses would not produce. Still ground it in the JTBD forces and technical research; do not be different for its own sake.' },
].slice(0, N)
const lenses = (a.conceptLenses && a.conceptLenses.length ? a.conceptLenses : defaultLenses)

const forcesDigest = 'Job statement: ' + ((forces && forces.jobStatement) || '') +
  '\nPush: ' + ((forces && forces.push) || []).map((f) => f.claim).join('; ') +
  '\nPull: ' + ((forces && forces.pull) || []).map((f) => f.claim).join('; ') +
  '\nAnxiety: ' + ((forces && forces.anxiety) || []).map((f) => f.claim).join('; ') +
  '\nHabit: ' + ((forces && forces.habit) || []).map((f) => f.claim).join('; ') +
  '\nRiskiest assumption: ' + ((forces && forces.riskiestAssumption && forces.riskiestAssumption.assumption) || '')

const concepts = (await parallel(lenses.map((c) => () =>
  agent(
    BRIEF + '\n\nJTBD forces:\n' + forcesDigest + '\n\nResearch:\n' + researchDigest +
    '\n\nYOUR LENS:\n' + c.prompt +
    '\n\nBe concrete and opinionated, not wishy-washy - this will be critiqued against ' + (N - 1) + ' other concept(s) and either chosen or merged. Include an honest account of what this concept does NOT solve well.',
    { label: c.label, phase: 'Diverge', schema: CONCEPT, model: model, effort: 'high' }
  )
))).filter(Boolean)
log('Diverge complete (' + concepts.length + ' concepts). Converging.')

// ── Phase 3: Converge - critique + one chosen/merged build spec ──────────────
phase('Converge')
const conceptsDigest = concepts.map((c) => '### ' + c.name + ' [' + c.lens + ']\nLayout: ' + c.layout + '\nStates: ' + (c.states || []).join(', ') + '\nIA: ' + c.informationArchitecture + '\nMaximizes: ' + c.jtbdFit.maximizes + ' | Defuses: ' + c.jtbdFit.defuses + ' | Does NOT solve: ' + c.jtbdFit.doesNotSolve + '\nWeaknesses: ' + (c.weaknesses || []).join('; ') + '\nVerdict: ' + c.verdict).join('\n\n---\n\n')

const converge = await agent(
  BRIEF + '\n\nJTBD forces:\n' + forcesDigest + '\n\nResearch:\n' + researchDigest + '\n\nCandidate concepts:\n\n' + conceptsDigest +
  '\n\nYou are the deciding designer. Pick the best approach - a hybrid/merge across concepts is legitimate Converge, do not force a single winner if merging genuinely serves the job better. Emit a concrete, implementable BUILD SPEC (layout + interaction model + information architecture, file:line anchors where relevant) detailed enough that an implementer needs no follow-up questions. Include a real state machine (not prose), an assumptions table with confidence levels, what you deliberately CUT from v1 and why, and genuine open decisions that need a human stakeholder call (not implementation details).',
  { label: 'converge', phase: 'Converge', schema: CONVERGE, model: model, effort: 'high' }
)
log('Converged on: ' + ((converge && converge.chosenApproach) || '(none)'))

// ── Phase 4: Prototype - spec handoff, or a best-effort delegated build ──────
phase('Prototype')
let prototype
if (fidelity === 'delegate-build' && repoPath !== '.') {
  prototype = await agent(
    BRIEF + '\n\nBUILD SPEC to implement:\n' + ((converge && converge.buildSpec) || '') +
    '\n\nState machine to implement exactly: ' + ((converge && converge.stateMachine) || []).join(', ') +
    '\n\nImplement this in the repo at ' + repoPath + '. Run the relevant tests and report actual pass/fail counts - do not claim success without running them. Return delivered="built", a concise summary, the exact artifact location(s), and the actual test command(s) with pass/fail counts.',
    { label: 'prototype-build', phase: 'Prototype', schema: PROTOTYPE, model: model, effort: 'high' }
  )
} else {
  prototype = { delivered: 'spec-only', summary: 'Spec-only fidelity (default). The invoking thread should build this - a workflow subagent may not have artifact-authoring tools (e.g. mcp_app_write) available.', artifactLocation: 'N/A - see converge.buildSpec', testResults: 'N/A' }
  log('Prototype phase: spec-only (pass fidelity: "delegate-build" + repoPath to attempt a real build instead).')
}

// ── Phase 5: Test - blind, task-based critique (testers see ONLY the spec) ───
phase('Test')
const testSubject = prototype.delivered === 'built' ? prototype.summary : ((converge && converge.buildSpec) || '')
const defaultTesters = [
  { label: 'test:cognitive-walkthrough', prompt: 'You are testing this BLIND - no design rationale, no backstory, just the spec/artifact and realistic tasks. Perform a first-time-user cognitive walkthrough: pick 4-6 realistic tasks implied by the job statement below and trace through them step by step, reporting exactly where you would hesitate, get confused, or get stuck. Be a real skeptical user, not a cheerleader.' },
  { label: 'test:heuristic-audit', prompt: 'You are testing this BLIND. Run a Nielsen 10-heuristic usability audit against the spec/artifact below. For each heuristic give PASS/PARTIAL/FAIL with a concrete reason; do not soften verdicts to be polite, and do not manufacture problems either.' },
  { label: 'test:stakeholder-skeptic', prompt: 'You are testing this BLIND, in character as the actual stakeholder described in the evidence below (infer their traits from the evidence, do not invent a generic persona). Walk through the single most realistic trigger scenario for this tool and narrate their reaction in character, then step out of character and give an honest verdict: would they actually use this, or bail back to their status quo behavior - and at exactly what point.' },
]
const testers = (a.testers && a.testers.length ? a.testers : defaultTesters)
const jobForTesters = 'Task context (the tasks below should probe this job): ' + ((forces && forces.jobStatement) || '(no job statement)') + '\n\nSTAKEHOLDER EVIDENCE (for the stakeholder-skeptic persona ONLY - other testers should ignore this and stay a generic user): ' + (a.evidence || '(none supplied)')
const findings = (await parallel(testers.map((t) => () =>
  agent(
    'SPEC/ARTIFACT UNDER TEST (this is ALL the context you get - no design rationale, no Converge reasoning):\n\n' + testSubject + '\n\n' + jobForTesters + '\n\nYOUR ROLE:\n' + t.prompt + '\n\nProduce the five worst problems you found, ranked, each with evidence. Explicitly flag anything you genuinely cannot verify from a spec/code-trace alone (visual polish, real latency, real discoverability) rather than guessing at it.',
    { label: t.label, phase: 'Test', schema: TESTFINDING, model: model, effort: 'high' }
  )
))).filter(Boolean)
const allProblems = findings.flatMap((f) => (f.topProblems || []).map((p) => ({ ...p, persona: f.persona })))
const highSeverity = allProblems.filter((p) => p.severity === 'high')
log('Test complete: ' + findings.length + ' testers, ' + allProblems.length + ' problems found (' + highSeverity.length + ' high-severity).')

const stakeholderTestPlan = 'Ship this to the real stakeholder with PRE-REGISTERED watch-fors (read their reaction against these predictions, not vibes): ' +
  ((converge && converge.openDecisionsForStakeholder) || []).join('; ') +
  (highSeverity.length ? '. Also watch specifically whether they hit: ' + highSeverity.map((p) => p.problem).join('; ') : '.')

return {
  jtbd: forces,
  research,
  concepts,
  converge,
  prototype,
  testFindings: findings,
  highSeverityProblems: highSeverity,
  stakeholderTestPlan,
  questionsForStakeholder: (forces && forces.questionsForStakeholder) || [],
}
