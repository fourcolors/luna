# Subagent Phase Brief — Template

Every phase dispatch to a subagent fills this template. Keep sections in order;
don't drop any.

---

## Phase N — <title>

### 1. Required reading (BEFORE writing any code)
- `/Users/sol/Projects/experiment-agent/DESIGN.md` — read these sections in full:
  - §<X.Y> — <why>
  - §3.4 (hard rules for executors — ALWAYS read)
  - §6 (error taxonomy — ALWAYS read)
  - §7 (service signatures this phase touches)
  - §12.2 (SDK adapter invariants, if the phase touches messages/hooks/tools)
- Existing code you must NOT modify but should reference:
  - `/Users/sol/Projects/experiment-agent/packages/<existing>/src/<file>.ts`

### 2. Scope (exactly what this phase ships)
- <package/module> with <N> source files + <M> test files
- Public API: <list the Tags/classes/functions that other phases will consume>
- Out of scope (explicit): <things that sound related but aren't this phase>

### 3. File layout (exact paths to create)
```
packages/<name>/package.json
packages/<name>/src/index.ts
packages/<name>/src/<...>.ts
packages/<name>/test/<...>.test.ts
```

### 4. Invariants you must honor (cite §-anchor)
- §3.4 #<n>: <rule> — how it applies here
- §6: errors go through <specific TaggedError> — do NOT invent new ones
- §7.<n>: service signature <Tag> — do NOT deviate from this shape
- §12.2 #<n>: <invariant>, if applicable

### 5. Tests required (Tier-1 minimum; more if noted)
- Happy path: <scenarios>
- Error path: <scenarios>
- Invariant enforcement: <specific test that would fail if invariant is broken>
- Tooling: vitest (under node); `bun test` also passes for bun-specific code paths
- Run `bun run test` and paste the final "Test Files … | Tests …" summary line
  into your return summary — no "all passed" without numbers

### 6. Constraints
- Do NOT modify files outside `packages/<name>/` and the single root `index` exports
  you are given permission for. If you think you need to, STOP and say why.
- Do NOT add dependencies outside the approved set: `effect`, `@experiment-agent/core`,
  `@experiment-agent/memory` (if relevant). Ask before adding anything else.
- Do NOT reformat/refactor existing code — only add new code.
- Typecheck must pass: `bun run typecheck` with zero errors.

### 7. Return summary shape (mandatory — your response MUST include all six)
1. Files created (list with one-line purpose each)
2. Files modified (list with reason; should be minimal — ideally only `packages/<name>/`)
3. Public API exported (the Tags/functions/types other phases will import)
4. Vitest output tail (the final summary line — literal, not paraphrased)
5. Typecheck output (pass/fail, with error tail if fail)
6. Invariants honored — for each §-anchor in section 4, one sentence: "§X.Y honored by <mechanism>"

### 8. Red flags (stop and report, don't guess)
- If DESIGN.md conflicts with the brief — report the conflict, do not resolve it
- If the advisor guidance in this brief conflicts with code you're reading — report
- If a test requires infrastructure you don't have (real SDK token, running service) —
  mark the test as `describe.skipIf(...)` and note it in your summary
- If you'd need to modify a frozen file (e.g., `packages/core/src/errors.ts`) — STOP
  and ask for explicit permission; do not edit it silently
