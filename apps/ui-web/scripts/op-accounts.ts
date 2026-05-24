export interface OpAccountConfig {
  readonly label: string
  readonly keychainService: string
  readonly keychainAccount: string
}

const LABEL_PATTERN = /^[a-z][a-z0-9_-]*$/

const parseEntry = (entry: string): OpAccountConfig => {
  const parts = entry.split(":").map((part) => part.trim())
  if (parts.length !== 1 && parts.length !== 3) {
    throw new Error(
      "LUNA_OP_ACCOUNTS entries must be <label> or <label>:<keychain-service>:<keychain-account>",
    )
  }

  const [label, service, account] = parts
  if (label === undefined || !LABEL_PATTERN.test(label)) {
    throw new Error(
      "LUNA_OP_ACCOUNTS label must start with a lowercase letter and contain only lowercase letters, numbers, '_' or '-'",
    )
  }

  if (parts.length === 1) {
    return {
      label,
      keychainService: `luna.op.${label}`,
      keychainAccount: label,
    }
  }

  if (
    service === undefined ||
    service.length === 0 ||
    account === undefined ||
    account.length === 0
  ) {
    throw new Error(
      "LUNA_OP_ACCOUNTS explicit entries require non-empty keychain service and account",
    )
  }

  return {
    label,
    keychainService: service,
    keychainAccount: account,
  }
}

export const resolveOpAccounts = (
  env: Record<string, string | undefined> = process.env,
): ReadonlyArray<OpAccountConfig> => {
  const raw = env["LUNA_OP_ACCOUNTS"]?.trim()
  if (raw === undefined || raw.length === 0) return []
  return raw.split(",").map((entry) => parseEntry(entry.trim()))
}
