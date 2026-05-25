export type StartMode = "local" | "ssh" | "none"

export interface ChatArgs {
  readonly command: "chat" | "help" | "unknown"
  readonly unknown: ReadonlyArray<string>
  readonly profile?: string
  readonly url?: string
  readonly fallbackUrl?: string
  readonly token?: string
  readonly threadId?: string
  readonly newThread?: boolean
  readonly localShell?: boolean
  readonly dangerouslyAutoApproveLocalShell?: boolean
  readonly startMode?: StartMode
  readonly startCommand?: string
  readonly startSsh?: string
  readonly fallbackStartSsh?: string
  readonly startTimeoutMs?: number
}

type ReadValueResult =
  | { readonly value: string; readonly nextIndex: number }
  | { readonly nextIndex: number; readonly error: string }

const readValue = (
  argv: ReadonlyArray<string>,
  index: number,
  flag: string,
): ReadValueResult => {
  const token = argv[index] ?? ""
  const eq = token.indexOf("=")
  if (eq > 0) {
    const value = token.slice(eq + 1)
    if (value.length === 0) return { nextIndex: index, error: `${flag} requires a value` }
    return { value, nextIndex: index }
  }
  const value = argv[index + 1]
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    return { nextIndex: index, error: `${flag} requires a value` }
  }
  return { value, nextIndex: index + 1 }
}

const isPositiveInteger = (value: string): boolean => /^[1-9]\d*$/.test(value)

export const parseChatArgs = (argv: ReadonlyArray<string>): ChatArgs => {
  const first = argv[0]
  if (first === undefined || first === "-h" || first === "--help") {
    return { command: "help", unknown: [] }
  }
  if (first !== "chat") {
    return { command: "unknown", unknown: [first] }
  }

  const out: {
    command: "chat"
    unknown: string[]
    profile?: string
    url?: string
    fallbackUrl?: string
    token?: string
    threadId?: string
    newThread?: boolean
    localShell?: boolean
    dangerouslyAutoApproveLocalShell?: boolean
    startMode?: StartMode
    startCommand?: string
    startSsh?: string
    fallbackStartSsh?: string
    startTimeoutMs?: number
  } = { command: "chat", unknown: [] }

  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i] as string
    const key = tok.includes("=") ? tok.slice(0, tok.indexOf("=")) : tok
    switch (key) {
      case "-h":
      case "--help":
        return { command: "help", unknown: [] }
      case "--url": {
        const r = readValue(argv, i, "--url")
        if ("error" in r) out.unknown.push(r.error)
        else out.url = r.value
        i = r.nextIndex
        break
      }
      case "--fallback-url": {
        const r = readValue(argv, i, "--fallback-url")
        if ("error" in r) out.unknown.push(r.error)
        else out.fallbackUrl = r.value
        i = r.nextIndex
        break
      }
      case "--token": {
        const r = readValue(argv, i, "--token")
        if ("error" in r) out.unknown.push(r.error)
        else out.token = r.value
        i = r.nextIndex
        break
      }
      case "--profile": {
        const r = readValue(argv, i, "--profile")
        if ("error" in r) out.unknown.push(r.error)
        else out.profile = r.value
        i = r.nextIndex
        break
      }
      case "--dev":
        out.profile = "dev"
        break
      case "--thread": {
        const r = readValue(argv, i, "--thread")
        if ("error" in r) out.unknown.push(r.error)
        else out.threadId = r.value
        i = r.nextIndex
        break
      }
      case "--new":
        out.newThread = true
        break
      case "--local-shell":
        out.localShell = true
        break
      case "--no-local-shell":
        out.localShell = false
        break
      case "--dangerously-auto-approve-local-shell":
        out.dangerouslyAutoApproveLocalShell = true
        break
      case "--start-mode": {
        const r = readValue(argv, i, "--start-mode")
        if ("error" in r) out.unknown.push(r.error)
        else if (r.value === "local" || r.value === "ssh" || r.value === "none") {
          out.startMode = r.value
        } else out.unknown.push("--start-mode must be local, ssh, or none")
        i = r.nextIndex
        break
      }
      case "--start-command": {
        const r = readValue(argv, i, "--start-command")
        if ("error" in r) out.unknown.push(r.error)
        else out.startCommand = r.value
        i = r.nextIndex
        break
      }
      case "--start-ssh": {
        const r = readValue(argv, i, "--start-ssh")
        if ("error" in r) out.unknown.push(r.error)
        else out.startSsh = r.value
        i = r.nextIndex
        break
      }
      case "--fallback-start-ssh": {
        const r = readValue(argv, i, "--fallback-start-ssh")
        if ("error" in r) out.unknown.push(r.error)
        else out.fallbackStartSsh = r.value
        i = r.nextIndex
        break
      }
      case "--start-timeout-ms": {
        const r = readValue(argv, i, "--start-timeout-ms")
        if ("error" in r) out.unknown.push(r.error)
        else if (!isPositiveInteger(r.value)) {
          out.unknown.push("--start-timeout-ms must be a positive integer")
        } else out.startTimeoutMs = Number(r.value)
        i = r.nextIndex
        break
      }
      default:
        out.unknown.push(tok)
    }
  }
  return out
}
