export const meta = {
  name: 'slice-research',
  description: 'Scope + design a code slice: parallel finders map the seams, N design variants, one judge emits a build spec',
  whenToUse: 'Before building a non-trivial slice whose shape or approach is uncertain. Pass the question, shared context, and repo path via args.',
  phases: [
    { title: 'Map', detail: 'parallel finders map the relevant seams' },
    { title: 'Design', detail: 'N scoped design variants (default 2)' },
    { title: 'Judge', detail: 'pick the tractable slice + emit a build spec' },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// slice-research — generalized from the capability-catalog research run.
//
// WHAT CHANGED vs the original one-off (per the 2026-06-25 retro):
//  • Design fan-out defaults to 2, not 3. The third variant was usually rejected
//    fast by the judge; size the fan-out to stakes. Override via args.designs.
//  • Finders + designs are caller-supplied via args (reusable beyond one slice),
//    with sensible defaults below.
//  • No inner backticks anywhere (the original review run failed to parse on a
//    stray backtick inside a template literal — string-concat / arrays instead).
//
// INVOKE:
//   Workflow({ name: 'slice-research', args: {
//     question: 'How should we add backend-advertised commands to Moon?',
//     context:  'What exists today / the goal / hard constraints ...',
//     repoPath: '/abs/path/to/repo-or-worktree',
//     finders:  [{ label, prompt }, ...],   // optional; overrides defaults
//     designs:  [{ label, prompt }, ...],   // optional; overrides defaults
//     designCount: 2,                        // optional; ignored if designs given
//     model: 'sonnet',                       // optional finder model
//   }})
// ─────────────────────────────────────────────────────────────────────────────

// Tolerate args arriving as a JSON string (a common invocation footgun); parse
// it so the run does not silently fall back to every default. See slice-review.
let a = args || {}
if (typeof a === 'string') { try { a = JSON.parse(a) } catch (e) { a = {} } }
const repoPath = a.repoPath || '.'
const finderModel = a.model || 'sonnet'

const PRE = [
  a.context || a.question || 'Research the slice described below.',
  a.question ? 'Question: ' + a.question : '',
  'Read REAL code and cite file:line. Repo to read: ' + repoPath + '. Distill findings, do not dump file contents.',
].filter(Boolean).join('\n\n')

// ── Schemas ──────────────────────────────────────────────────────────────────
const FIND = {
  type: 'object', additionalProperties: false,
  required: ['area', 'summary', 'mechanics', 'keyFiles', 'relevance', 'risks'],
  properties: {
    area: { type: 'string' }, summary: { type: 'string' },
    mechanics: { type: 'string', description: 'How it works end to end, with file:line anchors inline' },
    keyFiles: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'lines', 'role'], properties: { path: { type: 'string' }, lines: { type: 'string' }, role: { type: 'string' } } } },
    relevance: { type: 'string', description: 'How this bears on the design question' },
    risks: { type: 'array', items: { type: 'string' } },
  },
}
const DESIGN = {
  type: 'object', additionalProperties: false,
  required: ['name', 'scope', 'architecture', 'fileChanges', 'effort', 'risks'],
  properties: {
    name: { type: 'string' }, scope: { type: 'string' },
    architecture: { type: 'string', description: 'End to end: the seams touched and the data flow' },
    fileChanges: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'change'], properties: { path: { type: 'string' }, change: { type: 'string' } } } },
    effort: { type: 'string', enum: ['small', 'medium', 'large'] },
    risks: { type: 'array', items: { type: 'string' } },
  },
}
const JUDGE = {
  type: 'object', additionalProperties: false,
  required: ['recommended', 'rationale', 'buildSpec', 'openDecisions'],
  properties: {
    recommended: { type: 'string' }, rationale: { type: 'string' },
    buildSpec: { type: 'string', description: 'A concrete, implementable build spec for the chosen slice, with file:line anchors and a test plan' },
    openDecisions: { type: 'array', items: { type: 'string', description: 'Genuine product/architecture calls for a human' } },
  },
}

// ── Default seam-finders (override via args.finders) ─────────────────────────
const defaultFinders = [
  { label: 'find:pattern', prompt: 'Map the EXISTING pattern/feature this slice should mirror (the closest working precedent). Trace it end to end with file:line anchors so the new work can be modeled on it.' },
  { label: 'find:plumbing', prompt: 'Map the plumbing the slice must extend: where the relevant types/contracts/frames/handlers are defined and dispatched, and the exact steps to add a new one end to end.' },
  { label: 'find:integration', prompt: 'Map the integration point(s) where the new behavior plugs in (the consumer side): how data arrives, where it is rendered/handled, and where the new code must hook in.' },
  { label: 'find:first-step', prompt: 'Find the smallest REAL first step that ships user value, not a hollow demo. What concrete first unit of work proves the whole spine? Recommend exactly one and justify it against alternatives.' },
]
const finders = (a.finders && a.finders.length ? a.finders : defaultFinders)

log('slice-research config — repoPath=' + repoPath + ' finders=' + finders.length +
  (a.question ? ' question=yes' : ' question=NONE') +
  ((!a.repoPath || !a.question) ? ' (WARNING: some args fell back to defaults — was args passed as a real JSON object?)' : ''))

phase('Map')
const map = (await parallel(finders.map((f) => () =>
  agent(PRE + '\n\nYOUR AREA:\n' + f.prompt, { label: f.label, phase: 'Map', schema: FIND, agentType: 'Explore', model: finderModel, effort: 'medium' })
))).filter(Boolean)

const digest = map.map((f) => {
  const files = (f.keyFiles || []).map((k) => '- ' + k.path + ':' + k.lines + ' — ' + k.role).join('\n')
  return '## ' + f.area + '\n' + f.summary + '\n\nMechanics: ' + f.mechanics + '\n\nKey files:\n' + files + '\n\nRelevance: ' + f.relevance + '\nRisks: ' + (f.risks || []).join('; ')
}).join('\n\n---\n\n')
log('Map complete (' + map.length + ' finders). Designing.')

// ── Design variants (override via args.designs; else N generic framings) ─────
const N = Math.max(1, a.designCount || 2)
const defaultDesigns = [
  { label: 'design:thin-slice', prompt: 'Design the THINNEST end-to-end vertical slice that proves the whole spine with one real unit of work. Optimize for low blast radius and a fully-wired path over breadth.' },
  { label: 'design:real-value', prompt: 'Design the variant that ships the most genuinely useful first increment (accepting somewhat more work), built around the single most valuable concrete unit.' },
  { label: 'design:minimal-surface', prompt: 'Design the variant that adds the least new contract/protocol surface (reuse existing handshakes/frames/types), even if slightly less clean. Optimize for minimal new API to maintain.' },
].slice(0, N)
const designAngles = (a.designs && a.designs.length ? a.designs : defaultDesigns)

phase('Design')
const designs = (await parallel(designAngles.map((d) => () =>
  agent(PRE + '\n\nResearch map:\n\n' + digest + '\n\n' + d.prompt + '\n\nGround every file change in the real files. Be concrete about the data flow and the first real unit of work.', { label: d.label, phase: 'Design', schema: DESIGN, effort: 'high' })
))).filter(Boolean)

log('Designs complete (' + designs.length + '). Judging.')
phase('Judge')
const dtext = designs.map((d) => {
  const fc = (d.fileChanges || []).map((c) => '- ' + c.path + ': ' + c.change).join('\n')
  return '### ' + d.name + ' [' + d.effort + ']\nScope: ' + d.scope + '\nArchitecture: ' + d.architecture + '\nFile changes:\n' + fc + '\nRisks: ' + (d.risks || []).join('; ')
}).join('\n\n---\n\n')

const verdict = await agent(
  PRE + '\n\nResearch map:\n\n' + digest + '\n\nCandidate designs:\n\n' + dtext +
  '\n\nYou are the deciding architect. Pick the best TRACTABLE first slice (a hybrid is fine): it must ship a real increment end to end without boiling the ocean, mirror the proven precedent, treat any external/untrusted input as untrusted (decode at the boundary), and keep blast radius small. Emit a concrete BUILD SPEC (file:line anchors + a test plan) and list the genuine open decisions a human should make.',
  { label: 'judge', phase: 'Judge', schema: JUDGE, effort: 'high' }
)

return { map, designs, verdict }
