/**
 * tauri-acl-coverage.test.ts - the structural fence for a live-smoke finding.
 *
 * Runs under this suite's default DOM test environment, like every other
 * file here - pure fs/path work needs no DOM, but this repo's
 * vitest-setup.ts unconditionally touches the global window object (a
 * pre-existing, unrelated gap affecting any file that opts into the
 * non-DOM environment, confirmed via git stash on
 * test/thread-drag-session.test.ts before this fence existed - not this
 * file's bug to fix, so this file simply does not opt out).
 *
 * resolve_route_token was invoked by the frontend on every real connect, but
 * had NO src-tauri/permissions/allow-resolve-route-token.toml and NO
 * capability grant - so every real-app invoke rejected with
 * "resolve_route_token not allowed. Command not found", which connection.rs's
 * cause parser mapped into the durable 'Route unavailable' refusal. EVERY
 * existing test stubs invoke(), so nothing could ever have caught this - this
 * file reads the ACTUAL permission/capability files and the ACTUAL frontend
 * source on disk, with no stubbing at all, and is the only place in the suite
 * that can.
 *
 * THE INVARIANT: every Tauri command name the production frontend literally
 * invokes is covered by a permission that at least one capability grants to
 * SOME window. "Covered" means: a permissions/allow-*.toml file declares the
 * command under `[[permission]] ... commands.allow` (both the block
 * `[permission.commands]\nallow = [...]` shape and the inline
 * `commands.allow = [...]` shape are used across this project's files - see
 * allow-collapse-to-moon.toml vs allow-resolve-route-token.toml for one of
 * each), AND that permission's `identifier` string appears in at least one
 * capabilities/*.json file's top-level `permissions` array. A command with a
 * toml file that no capability ever grants is a dead permission (not what
 * this fence is for); a command invoked with no toml at all is exactly the
 * bug that shipped - both fail the same assertion below, with a message
 * naming which is missing and exactly what to create.
 *
 * OUT OF SCOPE, BY DESIGN (both counted, neither silently dropped):
 *   - PLUGIN-PREFIXED permissions (`dialog:allow-open`, `opener:allow-open-url`,
 *     `core:window:...`, `core:default`, `core:event:default`, etc.) - these
 *     are Tauri core/plugin permissions with no local permissions/*.toml file
 *     to parse; recognized by their `:` and simply not resolved to a local
 *     permission file. This fence only covers THIS app's own #[tauri::command]
 *     fns in main.rs and friends, which is exactly the class
 *     resolve_route_token belongs to.
 *   - NON-LITERAL invoke() calls (a variable first argument - e.g. the
 *     invokeTauri(cmd, args) generic-dispatcher wrapper functions' OWN
 *     `core.invoke(cmd, args)` line). These cannot be resolved to a command
 *     name by static scanning. Every wrapper's CALLERS still appear as
 *     literal invokes at their own call site (e.g. `invokeTauri('open_widget',
 *     ...)`), so a wrapper existing is not itself a blind spot - but a
 *     refactor to fully dynamic command dispatch (invoke(someVariable))
 *     WOULD be, silently. The pinned-ceiling test below is the guard against
 *     that: it does not assert non-literal invokes are ZERO (several already
 *     exist, legitimately, as the wrapper functions above, plus a few
 *     doc-comment false positives - see that test's own comment for the
 *     full, individually-verified breakdown), only that the count cannot
 *     grow past a small fixed number without a human noticing.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(__dirname, '..') // apps/ui-moon-tauri
const SRC_TAURI = path.join(ROOT, 'src-tauri')

// ── File collection ─────────────────────────────────────────────────────

function listFiles(dir: string, recursive: boolean, extensions: string[]): string[] {
  const out: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    throw new Error(`tauri-acl-coverage: scan directory does not exist: ${dir} (${(e as Error).message})`)
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (recursive) out.push(...listFiles(full, recursive, extensions))
      continue
    }
    if (!extensions.some((ext) => entry.name.endsWith(ext))) continue
    if (entry.name.includes('.test.') || entry.name.endsWith('.d.ts')) continue // NOT test files
    out.push(full)
  }
  return out
}

/** Production frontend sources ONLY - see this file's module doc for the exact scope. */
const TARGET_FILES: string[] = [
  ...listFiles(path.join(ROOT, 'frontend-react/src'), true, ['.ts', '.tsx']),
  ...listFiles(path.join(ROOT, 'frontend-react'), false, ['.html']), // frontend-react/*.html, not recursive
  ...listFiles(path.join(ROOT, 'frontend/vendor'), false, ['.js']),
  ...listFiles(path.join(ROOT, 'frontend/panels'), false, ['.js']),
  path.join(ROOT, 'frontend/index.html'),
]

// ── Step 1: scan for invoke('cmd_name' / invoke("cmd_name" literals ────────
//
// Matches both `ctx.invoke('x')`/`core.invoke('x')` (dotted) and the bare
// `invoke('x')` form (moon-session.js's internal _invoke/invoke helpers,
// chat-chrome-mount.tsx's, etc.) - `\b` before `invoke(` is what excludes
// `invokeTauri(` (more identifier characters follow, no word boundary at
// that position) without needing to special-case every wrapper name.

const INVOKE_CALL_RE = /\binvoke\(/g
const LITERAL_ARG_RE = /^\s*(['"])([a-zA-Z_][a-zA-Z0-9_]*)\1/

const invokedCommandFiles = new Map<string, Set<string>>() // command -> relative file paths it was found in
const nonLiteralInvokeSites: string[] = [] // "relative/path:line" for each non-literal invoke(

for (const file of TARGET_FILES) {
  const content = fs.readFileSync(file, 'utf8')
  const rel = path.relative(ROOT, file)
  for (const m of content.matchAll(INVOKE_CALL_RE)) {
    const after = content.slice(m.index! + m[0].length, m.index! + m[0].length + 200)
    const litMatch = after.match(LITERAL_ARG_RE)
    if (litMatch) {
      const cmd = litMatch[2]
      if (!invokedCommandFiles.has(cmd)) invokedCommandFiles.set(cmd, new Set())
      invokedCommandFiles.get(cmd)!.add(rel)
    } else {
      const line = content.slice(0, m.index).split('\n').length
      nonLiteralInvokeSites.push(`${rel}:${line}`)
    }
  }
}

const invokedCommands = new Set(invokedCommandFiles.keys())

// ── Step 2: the allowed command union ───────────────────────────────────

interface ParsedPermission {
  identifier: string
  commands: string[]
}

function parsePermissionFile(filePath: string): ParsedPermission {
  const content = fs.readFileSync(filePath, 'utf8')
  const idMatch = content.match(/identifier\s*=\s*"([^"]+)"/)
  if (!idMatch) {
    throw new Error(
      `tauri-acl-coverage: ${filePath} has no identifier = "..." line - the permission file ` +
        `shape changed and this parser needs updating (or the file is malformed).`,
    )
  }
  // Both shapes used across this project: the block form
  //   [permission.commands]
  //   allow = ["cmd"]
  // and the inline form
  //   commands.allow = ["cmd"]
  // Every permissions/*.toml here has exactly ONE allow = [...] array (the
  // commands list - verified by inspection; there is no other `allow =`
  // key in any file in this directory), so one match is authoritative.
  const allowMatch = content.match(/allow\s*=\s*\[([^\]]*)\]/)
  if (!allowMatch) {
    throw new Error(
      `tauri-acl-coverage: ${filePath} has no commands.allow = [...] array - the permission ` +
        `file shape changed and this parser needs updating (or the file is malformed).`,
    )
  }
  const commands = Array.from(allowMatch[1].matchAll(/"([a-zA-Z_][a-zA-Z0-9_]*)"/g)).map((m) => m[1])
  if (commands.length === 0) {
    throw new Error(`tauri-acl-coverage: ${filePath}'s commands.allow array parsed to zero commands - parser bug or malformed file.`)
  }
  return { identifier: idMatch[1], commands }
}

function parseCapabilityPermissions(filePath: string): string[] {
  const json = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  if (!Array.isArray(json.permissions)) {
    throw new Error(`tauri-acl-coverage: ${filePath} has no top-level "permissions" array - the capability file shape changed.`)
  }
  return json.permissions as string[]
}

const permissionFiles = listFiles(path.join(SRC_TAURI, 'permissions'), false, ['.toml'])
const capabilityFiles = listFiles(path.join(SRC_TAURI, 'capabilities'), false, ['.json'])

const grantedPermissionIdentifiers = new Set<string>()
for (const capFile of capabilityFiles) {
  for (const perm of parseCapabilityPermissions(capFile)) grantedPermissionIdentifiers.add(perm)
}

const allowedCommands = new Set<string>()
const commandToPermissionId = new Map<string, string>()
const commandToPermissionFile = new Map<string, string>()
for (const permFile of permissionFiles) {
  const { identifier, commands } = parsePermissionFile(permFile)
  // Plugin-prefixed identifiers never occur in this project's own
  // permissions/*.toml files (they only appear as capability grants for
  // Tauri core/plugin permissions, which have no local toml to parse) -
  // every identifier parsed here is this app's own, bare "allow-*" form.
  if (!grantedPermissionIdentifiers.has(identifier)) continue // toml exists but NO capability grants it
  for (const cmd of commands) {
    allowedCommands.add(cmd)
    commandToPermissionId.set(cmd, identifier)
    commandToPermissionFile.set(cmd, permFile)
  }
}

describe('Tauri ACL coverage (live-smoke fence: resolve_route_token had none)', () => {
  it('VACUOUS-PROOF: the scan actually found invoked commands and allowed commands - a broken glob must fail loudly, not pass', () => {
    // Realistically >= 20 distinct commands are invoked across this app
    // today; a much smaller number means a glob path is wrong and the main
    // assertion below would be vacuously true.
    expect(invokedCommands.size).toBeGreaterThanOrEqual(20)
    expect(allowedCommands.size).toBeGreaterThan(0)
    expect(TARGET_FILES.length).toBeGreaterThan(0)
    expect(permissionFiles.length).toBeGreaterThan(0)
    expect(capabilityFiles.length).toBeGreaterThan(0)
  })

  it('every frontend-invoked Tauri command is covered by a permission that some capability actually grants', () => {
    const uncovered = Array.from(invokedCommands)
      .filter((cmd) => !allowedCommands.has(cmd))
      .sort()

    if (uncovered.length > 0) {
      const detail = uncovered
        .map((cmd) => {
          const usedIn = Array.from(invokedCommandFiles.get(cmd) ?? [])
          const usedInText = usedIn.length > 0 ? usedIn.slice(0, 4).join(', ') + (usedIn.length > 4 ? ', ...' : '') : '(unknown)'
          const suggestedFile = `allow-${cmd.replace(/_/g, '-')}.toml`
          const suggestedId = `allow-${cmd.replace(/_/g, '-')}`
          return (
            `  "${cmd}" - invoked from: ${usedInText}\n` +
            `    This command will reject at runtime with "${cmd} not allowed. Command not found."\n` +
            `    FIX: create src-tauri/permissions/${suggestedFile}:\n` +
            `      [[permission]]\n` +
            `      identifier = "${suggestedId}"\n` +
            `      description = "Allows the ${cmd} command"\n` +
            `      [permission.commands]\n` +
            `      allow = [\n` +
            `        "${cmd}"\n` +
            `      ]\n` +
            `    THEN add "${suggestedId}" to the "permissions" array of every\n` +
            `    src-tauri/capabilities/*.json file whose windows must be able to call it\n` +
            `    (if a permissions/${suggestedFile} already exists but is uncovered here,\n` +
            `    the toml is fine - only the capabilities/*.json grant is missing).`
          )
        })
        .join('\n\n')
      throw new Error(
        `tauri-acl-coverage: ${uncovered.length} command(s) invoked by the frontend have NO ` +
          `working permission grant (this is the resolve_route_token bug class):\n\n${detail}`,
      )
    }

    expect(uncovered).toEqual([])
  })

  it('every hub_event name the frontend emits is in the Rust HUB_EVENT_NAMES allowlist', () => {
    // The same bug class as resolve_route_token, one level down: the COMMAND
    // was granted, but hub_event carries a name payload with its own Rust
    // allowlist (windows.rs HUB_EVENT_NAMES), and "machine-access-changed"
    // was invoked by the settings panel for the life of the feature while the
    // allowlist silently rejected it - every caller .catch(() => {})'d, and
    // every other test stubs invoke, so nothing could see it (found by the
    // #598 review). This case reads BOTH real sources off disk, unstubbed.
    const windowsRs = fs.readFileSync(path.join(SRC_TAURI, 'src/windows.rs'), 'utf8')
    const allowMatch = windowsRs.match(/const HUB_EVENT_NAMES:[^=]*=\s*&\[([^\]]*)\]/)
    expect(allowMatch, 'HUB_EVENT_NAMES not found in windows.rs - the fence needs updating').toBeTruthy()
    const allowed = new Set([...allowMatch![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!))
    // VACUOUS-PROOF: the parse actually found the known names.
    expect(allowed.has('fresh-thread')).toBe(true)

    const emitted = new Map<string, string>() // name -> first site
    const HUB_RE = /hub_event["']\s*,\s*\{\s*name:\s*(["'])([a-z-]+)\1/g
    for (const file of TARGET_FILES) {
      const content = fs.readFileSync(file, 'utf8')
      for (const m of content.matchAll(HUB_RE)) {
        if (!emitted.has(m[2]!)) emitted.set(m[2]!, path.relative(ROOT, file))
      }
    }
    // VACUOUS-PROOF: the scan found real emit sites (the settings panel's two
    // at minimum). A refactor that breaks the regex must fail here, loudly.
    expect(emitted.size, 'hub_event emit scan found nothing - the regex is stale').toBeGreaterThanOrEqual(2)

    const rejected = [...emitted].filter(([name]) => !allowed.has(name))
    expect(
      rejected,
      `frontend emits hub_event names the Rust allowlist rejects (windows.rs HUB_EVENT_NAMES): ` +
        rejected.map(([n, f]) => `"${n}" (${f})`).join(', '),
    ).toEqual([])
  })

  it('non-literal invoke() calls stay under a small pinned ceiling (a refactor to dynamic dispatch must not silently blind this fence)', () => {
    // 18 as of this writing, verified individually - two honest categories,
    // NEITHER a blind spot today:
    //   - ~11 are the generic dispatcher wrapper pattern repeated across the
    //     app: a method/function literally named `invoke(cmd, args)` (or
    //     `invokeTauri`'s own body) that forwards to core.invoke(cmd, args) -
    //     bootChat.ts, main-widget.tsx (2 sites each: the `args === undefined`
    //     ternary's two branches), chatEngine.ts, hubEngines.ts, and the
    //     inlined equivalents in panel.html/index.html. Every one of THESE
    //     wrappers' real CALLERS still passes a literal command name at
    //     their own call site (invokeTauri('open_widget', ...), etc.), which
    //     the scan above already counts - the wrapper existing is not a gap.
    //   - ~7 are doc-comment PROSE mentioning "ctx.invoke()" descriptively
    //     (connectionReducer.ts, connectorsReducer.ts, SettingsConnectionPanel.tsx,
    //     ConnectorsPanel.tsx, VoicePanel.tsx, UpdatesPanel.tsx) - zero real
    //     code, the regex just cannot distinguish text inside a comment from
    //     a real call. Harmless: it only inflates this health-check count,
    //     never the main coverage assertion above (which requires an actual
    //     matching QUOTE character, so prose with no quotes never becomes a
    //     phantom "allowed" command either).
    // This ceiling exists so a FUTURE move to fully dynamic command dispatch
    // (invoke(someVariable) with a REAL variable command name) trips a human
    // review instead of silently shrinking what this fence can see.
    const CEILING = 30
    expect(
      nonLiteralInvokeSites.length,
      `non-literal invoke() call sites:\n${nonLiteralInvokeSites.join('\n')}`,
    ).toBeLessThanOrEqual(CEILING)
    expect(nonLiteralInvokeSites.length).toBeGreaterThan(0) // sanity: the detector itself works
  })
})
