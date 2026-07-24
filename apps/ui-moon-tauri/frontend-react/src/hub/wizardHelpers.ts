/**
 * wizardHelpers.ts - pure helpers extracted from the deleted vanilla
 * SetupWizard object (frontend/index.html) so they are unit-testable without
 * jsdom/Tauri. No DOM, no network, no Tauri - every function here is a plain
 * string/data transform. Mirrors the workflows panel's model.ts convention.
 */

export const REPO_URL = "https://github.com/fourcolors/luna.git"
// sh -c under a .app bundle inherits launchd's anaemic PATH - without this
// prelude `bun` (in ~/.bun/bin) and brew git are invisible.
export const PATH_PRELUDE =
  'export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; '

/**
 * "~/luna" -> `"$HOME/luna"` (shell-expanded), "/abs/path" -> `"/abs/path"`.
 * Rejects characters that would break out of the double quotes. Returns null
 * for anything unsafe or relative-and-ambiguous (sh -c has no meaningful cwd).
 */
export function dirShellExpr(dir: string): string | null {
  if (!/^[A-Za-z0-9._/~ -]+$/.test(dir)) return null
  if (dir === "~") return '"$HOME"'
  if (dir.startsWith("~/")) return `"$HOME/${dir.slice(2)}"`
  if (dir.startsWith("/")) return `"${dir}"`
  return null
}

export interface RemoteCmdResult {
  readonly cmd: string
  readonly wsGuess: string
}

/**
 * Render the tailored copy-paste remote-install command from a raw
 * (untrusted, possibly pasted-with-junk) host field. Only interpolates an
 * ssh destination that LOOKS like one (user@host, hostname, or IPv4) -
 * anything else falls back to the placeholder so a stray copy-paste with
 * whitespace/quotes can't produce a broken (or surprising) one-liner.
 */
export function renderRemoteCmd(rawHost: string): RemoteCmdResult {
  const raw = (rawHost || "").trim()
  const safe = /^[A-Za-z0-9._@-]+$/.test(raw) ? raw : ""
  const host = safe || "user@your-server"
  const cmd =
    `ssh -t ${host} '` +
    `git clone ${REPO_URL} ~/luna 2>/dev/null || git -C ~/luna pull --ff-only; ` +
    `cd ~/luna && sudo bash scripts/luna-server-install && ` +
    `grep ^UI_WS_TOKEN ~/.luna/.env'`
  const bare = safe.includes("@") ? safe.split("@").pop() ?? "" : safe
  const wsGuess = bare ? `ws://${bare}:4753/ui` : ""
  return { cmd, wsGuess }
}

/** data-step -> "install vs update" wording pair for the local step. */
export function localStepCopy(update: boolean): {
  title: string
  sub: string
  startLabel: string
} {
  return update
    ? {
        title: "Update Luna on this Mac",
        sub:
          "I’ll fetch Luna’s newest code, refresh her pieces, and wake her back up. " +
          "Your chats and memories stay put in ~/.luna.",
        startLabel: "Update & restart",
      }
    : {
        title: "Set up Luna on this Mac",
        sub: "I’ll download Luna, set her up, and wake her - all on this machine. Nothing leaves your Mac.",
        startLabel: "Install & start",
      }
}

export function pathCardLocalDesc(env: { serverRunning: boolean; repoExists: boolean }): string {
  if (env.serverRunning) return "Luna already lives here - connect, or update her"
  if (env.repoExists) return "Luna is installed here - wake her up, or update her"
  return "Everything stays private, right on this computer"
}

export function detectNoteText(env: { serverRunning: boolean; repoExists: boolean }): string | null {
  if (env.serverRunning) return "✓ Good news - Luna is already running on this Mac."
  if (env.repoExists) return "✓ Luna is installed on this Mac - she just isn’t awake."
  return null
}

/** Where wizard-connect Back should land, given the chosen path + install history. */
export function connectBackStep(
  chosenPath: "local" | "remote" | "connect" | null,
  ranInstall: boolean,
): "remote" | "progress" | "local" | "path" {
  if (chosenPath === "remote") return "remote"
  if (chosenPath === "local") return ranInstall ? "progress" : "local"
  return "path"
}
