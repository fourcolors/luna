# Luna Next

Luna Next is the simplification branch informed by the 2026-07-31 greenfield redesign analysis.
Every change lands as a small stacked PR on branch `luna-next` for Operator review.

## Decisions

1. Moon (`apps/ui-moon-tauri`) is the only graphical UI going forward.
   `ui-studio-tauri` and the `ui-web` frontend are retired.
   `ui-web`'s frontend is deleted only after the chat server daemon is extracted out of `apps/ui-web/scripts/`, which is Stack 2.
   The terminal client (`apps/agent-cli`) and the Telegram channel stay.
2. Duplicate concepts collapse to one path: one component set (Moon's), one reflection runtime (dream+wake merge, Stack 2), one tool-package factory, one memory backend.
3. The model gets more trust in judgment: what to remember, proposed remedies, structured output by default where the provider supports it.
   The model gets zero new trust in irreversible execution: no model in the rollback loop, egress allowlist, shell deny-rails, secret chain, push/PR path, or the markdown sanitizer.
4. The provider-capability profile (`packages/core/src/provider-profile.ts`) is a routing input.
   Every SDK-native adoption is gated per lane on its capability flag, with exactly one portable fallback, because Luna deliberately keeps local model lanes.
5. Every behavioral change carries an acceptance metric and an abandon condition, measured with harnesses already in the repo: retrieval bench, cost ledger, job-run history.

## Stack 1 (this stack)

1. charter
2. drop studio shell
3. drop `packages/ui-shared-solid`
4. drop workflow-runtime
5. drop dead memory backends
6. drop turn-capture regexes
7. drop tier classifier + calibration
8. drop Haiku rerank stack
9. shellcheck CI gate
10. capability-gate helper
11. structured output default-on

## Stack 2 (planned)

- Add the `defineToolPackage` factory, then migrate all ten tool packages onto it.
- Extract the server to `apps/server` (coordinated deploy migration).
- Delete the `ui-web` frontend.
- Unify dream+wake into one `ReflectionJob`.
- Split `chat-service.ts` / `job-ticker.ts` / `main.rs` along existing seams.
- Establish a `luna.db` schema-continuity contract before any daemon cutover.

## Stack 3 (planned)

- Rebuild Moon chat as bundled typed React: delete the vanilla vendor layer and dual-mount bridge, keep the audited markdown sanitizer.
- Fold guardian/update-server/autodeploy into one typed compiled binary on the existing `ServerUpdateDriver` contract, keeping a bash escape hatch.

## Review rules

- One concern per PR.
- The PR body states what, why, and how it was verified.
- Deletions must show the verification greps.
- Nothing merges out of stack order.
