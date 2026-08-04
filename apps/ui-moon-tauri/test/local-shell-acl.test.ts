/**
 * local-shell-acl.test.ts
 *
 * Behavior: the Tauri capability ACL must authorize `local_shell_exec` for
 * EVERY window a chat panel can occupy - the singleton `panel-chat` AND the
 * parallel-thread instances `panel-chat-<hash>` minted by panel_instance_label
 * (src-tauri/src/main.rs) when the title-bar "+" opens a chat panel WITH params
 * (frontend/chat.html ~L9193). Non-chat system panels must stay denied
 * (least privilege).
 *
 * Why this is the right surface: Tauri enforces command permissions per WINDOW
 * LABEL, before the command body runs. Granting `allow-local-shell-exec` only
 * to the exact `panel-chat` label means a parallel-thread panel (label
 * `panel-chat-<hash>`, which matches only the shell-LESS `panel-*` glob in
 * panels.json) is rejected with "Command local_shell_exec not allowed by ACL"
 * even when the operator enabled machine access. This suite is a pure config
 * invariant - it parses the committed capability JSON and replays Tauri's
 * window-label glob match over EVERY capability file, so it needs no running
 * app. (Full runtime ACL enforcement is integration-only.)
 */
import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"

const capDir = path.resolve(__dirname, "../src-tauri/capabilities")
const registryPath = path.resolve(__dirname, "../frontend/vendor/widget-registry.json")
const SHELL_PERMISSION = "allow-local-shell-exec"

type Capability = { windows?: string[]; permissions?: string[] }

// Enumerate the dir dynamically so the ACL replay sees EVERY shipped capability,
// exactly as the Tauri runtime does - a newly-added or renamed file can never
// silently drop out of the grant/deny guards below.
function capNames(): string[] {
  return fs.readdirSync(capDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5))
}
function readCap(name: string): Capability {
  return JSON.parse(fs.readFileSync(path.join(capDir, name + ".json"), "utf8"))
}

/**
 * Approximates Tauri's window-label glob match for the plain `*` patterns Moon's
 * capabilities use (tauri 2.11.2 / glob crate, case-sensitive). `*` maps to
 * `[^/]*` - it does NOT cross the `/` separator, matching glob semantics - and
 * `?` / `[...]` are intentionally unsupported (none appear in our patterns); an
 * unsupported form throws rather than silently mismatching. Moon labels are
 * slash-free today, so this is exact for the current label set.
 */
function windowGlobMatches(pattern: string, label: string): boolean {
  if (/[?[\]]/.test(pattern)) throw new Error("unsupported glob form in window pattern: " + pattern)
  const rx = new RegExp(
    "^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$",
  )
  return rx.test(label)
}

/**
 * Replays the runtime ACL over EVERY committed capability file (Tauri unions
 * permissions across all of them): does any capability that grants the shell
 * permission have a `windows` entry matching this label?
 */
function aclGrantsShell(label: string): boolean {
  return capNames().some((name) => {
    let cap: Capability
    try {
      cap = readCap(name)
    } catch (e) {
      // Files come from readdir, so they exist; the only throw is a JSON parse
      // failure - a malformed (possibly over-granting) capability must fail
      // loudly, NOT read as "grants no shell".
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false
      throw e
    }
    if (!(cap.permissions || []).includes(SHELL_PERMISSION)) return false
    return (cap.windows || []).some((w) => windowGlobMatches(w, label))
  })
}

// panel_label(kind) (src-tauri/src/windows.rs): lowercase kind, dots -> dashes, 'panel-' prefix.
function panelLabel(kind: string): string {
  return "panel-" + kind.replace(/\./g, "-")
}
function registryKinds(): string[] {
  const reg = JSON.parse(fs.readFileSync(registryPath, "utf8")) as { widgets: { kind: string }[] }
  return reg.widgets.map((w) => w.kind)
}

// A representative parallel-thread instance label: panel_label('chat') + '-' +
// a djb2 hex of the params. The exact hash is irrelevant - any `panel-chat-*`.
const INSTANCE_LABEL = "panel-chat-1f4e9c"

describe("Feature: local shell ACL covers every chat-panel window", () => {
  it("B1 [green guard] Given the singleton chat panel, When the ACL is evaluated, Then shell is granted to label panel-chat", () => {
    expect(aclGrantsShell("panel-chat")).toBe(true)
  })

  it("B2 [green guard] Given the main hub window, When the ACL is evaluated, Then shell is granted to label main", () => {
    expect(aclGrantsShell("main")).toBe(true)
  })

  it("B3 [RED->green] Given a parallel-thread chat panel (panel-chat-<hash>), When the ACL is evaluated, Then shell is granted to that instance label", () => {
    expect(aclGrantsShell(INSTANCE_LABEL)).toBe(true)
  })

  it("B4 [green guard / least privilege] Given a non-chat system panel (singleton OR instance), When the ACL is evaluated, Then shell is NOT granted", () => {
    // If a fix over-grants by adding shell to panels.json's panel-* glob, these flip to true and fail.
    expect(aclGrantsShell("panel-settings")).toBe(false)
    expect(aclGrantsShell("panel-now")).toBe(false)
    expect(aclGrantsShell("panel-actions")).toBe(false)
    // A non-chat INSTANCE label (panel_instance_label for e.g. kind 'flow') must also be denied.
    expect(aclGrantsShell("panel-flow-1a2b3c")).toBe(false)
  })

  it("B5 [green guard] the chat capability literally carries the panel-chat-* grant, and the glob matcher is sound", () => {
    // Lock the exact windows shape the fix introduced, so a regression that drops
    // the glob fails HERE with a precise message, not just behaviorally in B3.
    expect(readCap("chat").windows || []).toEqual(expect.arrayContaining(["panel-chat", "panel-chat-*"]))
    expect((readCap("chat").permissions || [])).toContain(SHELL_PERMISSION)
    // Matcher soundness: panel-chat-* must not leak to siblings, and must not match the bare singleton.
    expect(windowGlobMatches("panel-chat-*", INSTANCE_LABEL)).toBe(true)
    expect(windowGlobMatches("panel-chat-*", "panel-settings")).toBe(false)
    expect(windowGlobMatches("panel-chat", INSTANCE_LABEL)).toBe(false)
  })
})

describe("Feature: only the chat kind may inherit the shell-granted panel-chat-* glob", () => {
  it("B6 [least-privilege foot-gun guard] no non-chat registry kind produces a label matching panel-chat-*", () => {
    // panel_label maps dots to dashes, so a FUTURE chat.* system kind (e.g.
    // chat.export -> panel-chat-export) would silently inherit chat's shell ACL
    // via the panel-chat-* glob. Pin the invariant: 'chat' is the only kind in
    // the chat namespace. A new chat.* panel then forces a conscious decision.
    const offenders = registryKinds().filter(
      (kind) => kind !== "chat" && windowGlobMatches("panel-chat-*", panelLabel(kind)),
    )
    expect(offenders).toEqual([])
  })
})
