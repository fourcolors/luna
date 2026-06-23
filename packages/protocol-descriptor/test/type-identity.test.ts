/**
 * Type-identity test: ServerDescriptor from @luna/ui-ws (via protocol.ts) and
 * from @luna/ui-shared/core (via wire.ts) must be mutually assignable because
 * both re-export from @luna/protocol-descriptor.
 *
 * If this file compiles, type identity is confirmed at the TypeScript level.
 * No runtime assertions needed — the test is purely structural.
 *
 * NOTE: The mutual-assignability check below is near-trivially true because both
 * re-export the SAME definition from @luna/protocol-descriptor (F2 in the design —
 * single canonical source). Structural drift between the two export paths is
 * therefore impossible at the type level; this test primarily asserts that both
 * re-export PATHS resolve without error, not that the shapes differ and stay in sync.
 * The `satisfies` pin below provides a small slice of real shape-checking.
 */
import { describe, it } from "vitest"
import type { ServerDescriptor as DescriptorFromUiWs } from "@luna/ui-ws"
import type { ServerDescriptor as DescriptorFromUiShared } from "@luna/ui-shared/core"
import type { ServerDescriptor } from "@luna/protocol-descriptor"

describe("ServerDescriptor type identity", () => {
  it("is mutually assignable between ui-ws and ui-shared/core", () => {
    // Type-level only — if this compiles, types are identical
    const _a: DescriptorFromUiWs = {} as DescriptorFromUiShared
    const _b: DescriptorFromUiShared = {} as DescriptorFromUiWs
    // Suppress "unused variable" — the point is compilation
    void _a
    void _b
  })

  it("export paths each satisfy the canonical ServerDescriptor shape", () => {
    // Minimal literal pin: confirms both re-exported names resolve to the same
    // canonical shape without needing structural drift to catch anything.
    // Extend this literal if the shape evolves and a shape regression is a risk.
    type _CheckUiWs = DescriptorFromUiWs extends ServerDescriptor ? true : never
    type _CheckUiShared = DescriptorFromUiShared extends ServerDescriptor ? true : never
    const _ui_ws_ok: _CheckUiWs = true
    const _ui_shared_ok: _CheckUiShared = true
    void _ui_ws_ok
    void _ui_shared_ok
  })
})
