/**
 * pair-qr — print a `luna://connect?…` pairing link + terminal QR code that
 * the iOS app (apps/ios) scans to configure its chat-server connection.
 *
 * Payload carries host, port, the UI_WS_TOKEN bearer token, and a tls flag —
 * the same four fields the app's Settings screen asks for.
 *
 * Usage:
 *   bun run apps/server/scripts/pair-qr.ts [--host <ip>] [--port <n>] [--tls]
 *
 * Token resolution mirrors the server: process env first, then ~/.luna/.env
 * (UI_WS_TOKEN, falling back to LUNA_UI_WS_TOKEN). Host defaults to the first
 * non-internal IPv4 (override with --host when that's wrong — VPNs, bridges).
 */
import { existsSync, readFileSync } from "node:fs"
import { networkInterfaces } from "node:os"
import { resolveRuntimePaths } from "../src/runtime-paths.js"

import qrcode from "qrcode-terminal"

// Same naive KEY=VALUE parse as chat-server's boot block: process env wins
// over the file so supervisor-defined secrets keep their precedence.
{
  const envFile = resolveRuntimePaths().envFilePath
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const trimmed = line.trim()
      if (trimmed === "" || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      if (key && !(key in process.env)) process.env[key] = trimmed.slice(eq + 1).trim()
    }
  }
}

const arg = (name: string): string | undefined => {
  const idx = process.argv.indexOf(name)
  return idx !== -1 ? process.argv[idx + 1] : undefined
}
const flag = (name: string): boolean => process.argv.includes(name)

const token = (process.env.UI_WS_TOKEN ?? process.env.LUNA_UI_WS_TOKEN)?.trim()
if (!token || token.length < 16) {
  console.error(
    "[pair-qr] no UI_WS_TOKEN found — set it in the environment or ~/.luna/.env (≥16 chars)",
  )
  process.exit(2)
}

const firstLanIPv4 = (): string | undefined => {
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal && !info.address.startsWith("169.254.")) {
        return info.address
      }
    }
  }
  return undefined
}

// --host wins; then the server's configured bind if it's a concrete address
// (0.0.0.0 listens on all interfaces but isn't dialable); else auto-detect.
const configured = process.env.LUNA_UI_WS_HOST?.trim()
const host =
  arg("--host") ??
  (configured && configured !== "0.0.0.0" && configured !== "::" ? configured : undefined) ??
  firstLanIPv4()
if (!host) {
  console.error("[pair-qr] could not detect a LAN address — pass one with --host <ip>")
  process.exit(2)
}

const port = Number(arg("--port") ?? "4753")
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`[pair-qr] bad --port ${arg("--port")}`)
  process.exit(2)
}
const tls = flag("--tls")

const url =
  `luna://connect?host=${encodeURIComponent(host)}` +
  `&port=${port}&token=${encodeURIComponent(token)}&tls=${tls ? 1 : 0}`

console.log(`\nLuna pairing link (keep private — it carries your UI_WS_TOKEN):\n\n  ${url}\n`)
qrcode.generate(url, { small: true })
console.log(
  `Scan with the iOS app (Settings → Pair → Scan code), or paste the link via Paste link.\n`,
)
const boundLoopback = !configured || configured === "127.0.0.1" || configured === "::1"
if (boundLoopback && !arg("--host")) {
  console.log(
    `Note: the chat server is not bound to a LAN interface (LUNA_UI_WS_HOST=${configured ?? "unset"}). ` +
      `A physical iPhone can't reach ${host} until you run the server with LUNA_UI_WS_HOST=0.0.0.0 ` +
      `— the QR only helps a simulator on this machine.\n`,
  )
}
