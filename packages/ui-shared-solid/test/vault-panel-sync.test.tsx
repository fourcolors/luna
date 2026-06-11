// @vitest-environment jsdom
/**
 * VaultPanel V3 tests — sync section and CSV import.
 *
 * Covers:
 *   - parseAppleCsv: quoted commas, embedded newlines, escaped quotes,
 *     CRLF, reordered headers, missing-password rows, OTPAuth column.
 *   - humanizeRelTime
 *   - Sync section: renders state from props.sync, datalist labels, save frame.
 *   - Import disabled when sync off (shows explainer + disabled button).
 *   - Preview shows titles NEVER passwords.
 *   - Chunking (IMPORT_CHUNK_SIZE per frame, protocol cap 20) with sequential acks.
 *   - Abort-on-failed-chunk honesty.
 *   - State wiped after completion.
 */

import { describe, expect, it, vi, afterEach, beforeEach } from "vitest"
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import type { VaultWireItem, VaultSyncWire } from "@luna/ui-shared"
import {
  VaultPanel,
  type VaultStatusAck,
  parseAppleCsv,
  humanizeRelTime,
  type AppleCsvRow,
} from "../src/VaultPanel.jsx"

// ── parseAppleCsv unit tests ─────────────────────────────────────────────────

describe("parseAppleCsv — basic parsing", () => {
  it("parses a standard Apple Passwords CSV with all columns", () => {
    const csv = `Title,URL,Username,Password,Notes,OTPAuth
My Site,https://example.com,alice@test.com,hunter2,some note,`
    const rows = parseAppleCsv(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe("My Site")
    expect(rows[0]!.url).toBe("https://example.com")
    expect(rows[0]!.username).toBe("alice@test.com")
    expect(rows[0]!.password).toBe("hunter2")
    expect(rows[0]!.notes).toBe("some note")
  })

  it("handles CRLF line endings", () => {
    const csv = "Title,URL,Username,Password,Notes,OTPAuth\r\nSite A,,,,," + "\r\n"
    // Site A has no password → dropped
    const rows = parseAppleCsv(csv)
    expect(rows).toHaveLength(0)

    const csv2 = "Title,URL,Username,Password,Notes,OTPAuth\r\nSite A,,user,pw123,,\r\n"
    const rows2 = parseAppleCsv(csv2)
    expect(rows2).toHaveLength(1)
    expect(rows2[0]!.title).toBe("Site A")
    expect(rows2[0]!.password).toBe("pw123")
  })

  it("skips rows with missing title", () => {
    const csv = `Title,URL,Username,Password,Notes,OTPAuth
,https://example.com,user,pass123,note,`
    const rows = parseAppleCsv(csv)
    expect(rows).toHaveLength(0)
  })

  it("skips rows with missing password", () => {
    const csv = `Title,URL,Username,Password,Notes,OTPAuth
My Site,https://example.com,user,,note,`
    const rows = parseAppleCsv(csv)
    expect(rows).toHaveLength(0)
  })

  it("returns empty array for CSV with only headers", () => {
    const csv = "Title,URL,Username,Password,Notes,OTPAuth\n"
    expect(parseAppleCsv(csv)).toHaveLength(0)
  })

  it("returns empty array for empty string", () => {
    expect(parseAppleCsv("")).toHaveLength(0)
  })

  it("returns empty array when required columns are missing from header", () => {
    // No 'Password' column at all
    const csv = "Title,URL,Username,Notes\nSite,url,user,note"
    expect(parseAppleCsv(csv)).toHaveLength(0)
  })
})

describe("parseAppleCsv — quoted fields", () => {
  it("handles quoted fields with embedded commas", () => {
    const csv = `Title,URL,Username,Password,Notes,OTPAuth
"Site, Inc.",https://example.com,user,pa$$word,,`
    const rows = parseAppleCsv(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe("Site, Inc.")
  })

  it("handles quoted fields with embedded newlines", () => {
    const csv = `Title,URL,Username,Password,Notes,OTPAuth
My Site,https://example.com,user,pa$$word,"line1\nline2",`
    const rows = parseAppleCsv(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.notes).toBe("line1\nline2")
  })

  it("handles escaped double quotes (\"\") inside quoted fields", () => {
    const csv = `Title,URL,Username,Password,Notes,OTPAuth
"My ""Best"" Site",https://example.com,user,password,,`
    const rows = parseAppleCsv(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe('My "Best" Site')
  })

  it("handles password with embedded quotes", () => {
    const csv = `Title,URL,Username,Password,Notes,OTPAuth
Site,url,user,"p@ss""word",,`
    const rows = parseAppleCsv(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.password).toBe('p@ss"word')
  })
})

describe("parseAppleCsv — reordered headers", () => {
  it("handles columns in different order (Password before Username)", () => {
    const csv = `Password,Title,URL,Username,Notes
mypass,My Site,https://example.com,user,`
    const rows = parseAppleCsv(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe("My Site")
    expect(rows[0]!.password).toBe("mypass")
  })

  it("tolerates OTPAuth column being absent from header", () => {
    const csv = `Title,URL,Username,Password,Notes
Simple Site,https://example.com,user,pass123,`
    const rows = parseAppleCsv(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe("Simple Site")
    expect(rows[0]!.password).toBe("pass123")
  })

  it("case-insensitive column header matching", () => {
    const csv = `TITLE,URL,USERNAME,PASSWORD,NOTES
My Site,url,user,secret123,`
    const rows = parseAppleCsv(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe("My Site")
    expect(rows[0]!.password).toBe("secret123")
  })

  it("ignores OTPAuth column entirely (never appears in output)", () => {
    const csv = `Title,URL,Username,Password,Notes,OTPAuth
Site A,url,user,pass,note,otpauth://totp/foo?secret=JBSWY3DPEHPK3PXP`
    const rows = parseAppleCsv(csv)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    // OTPAuth should not appear anywhere in the output
    expect(Object.keys(row)).not.toContain("otpauth")
    expect(Object.keys(row)).not.toContain("OTPAuth")
  })
})

describe("parseAppleCsv — multiple rows", () => {
  it("returns multiple rows", () => {
    const csv = `Title,URL,Username,Password,Notes,OTPAuth
Site A,https://a.com,user1,pass1,,
Site B,https://b.com,user2,pass2,,
Site C,https://c.com,user3,pass3,,`
    const rows = parseAppleCsv(csv)
    expect(rows).toHaveLength(3)
    expect(rows[0]!.title).toBe("Site A")
    expect(rows[1]!.title).toBe("Site B")
    expect(rows[2]!.title).toBe("Site C")
  })
})

// ── humanizeRelTime unit tests ────────────────────────────────────────────────

describe("humanizeRelTime", () => {
  it("shows 'just now' for < 60 seconds", () => {
    const now = Date.now()
    expect(humanizeRelTime(now - 30_000, now)).toBe("just now")
    expect(humanizeRelTime(now - 0, now)).toBe("just now")
  })

  it("shows minutes ago for < 60 minutes", () => {
    const now = Date.now()
    expect(humanizeRelTime(now - 3 * 60_000, now)).toBe("3 minutes ago")
    expect(humanizeRelTime(now - 60_000, now)).toBe("1 minute ago")
  })

  it("shows hours ago for < 24 hours", () => {
    const now = Date.now()
    expect(humanizeRelTime(now - 2 * 3600_000, now)).toBe("2 hours ago")
    expect(humanizeRelTime(now - 3600_000, now)).toBe("1 hour ago")
  })

  it("shows days ago for >= 24 hours", () => {
    const now = Date.now()
    expect(humanizeRelTime(now - 2 * 24 * 3600_000, now)).toBe("2 days ago")
    expect(humanizeRelTime(now - 24 * 3600_000, now)).toBe("1 day ago")
  })
})

// ── Sync section component tests ─────────────────────────────────────────────

const makeItem = (overrides: Partial<VaultWireItem> = {}): VaultWireItem => ({
  id: "item-1",
  name: "OpenAI API Key",
  kind: "env-secret",
  ref: "env:OPENAI_API_KEY",
  source: "manual",
  description: null,
  createdAt: 1000,
  updatedAt: 1000,
  synced: false,
  shadowed: false,
  ...overrides,
})

const makeOpTokenItem = (label: string): VaultWireItem =>
  makeItem({
    id: `item-${label}`,
    name: `Token ${label}`,
    kind: "op-token",
    ref: `luna-op://${label}`,
  })

interface SyncRig {
  container: HTMLElement
  putCalls: Array<Parameters<ConstructorParameters<typeof VaultPanel>[0]["onPut"]>[0]>
  deleteCalls: Array<Parameters<ConstructorParameters<typeof VaultPanel>[0]["onDelete"]>[0]>
  syncConfigCalls: Array<{
    requestId: string
    enabled: boolean
    opLabel?: string
    opVault?: string
    pollSeconds?: number
  }>
  importCalls: Array<{
    requestId: string
    items: ReadonlyArray<{
      title: string
      url?: string
      username?: string
      password: string
      notes?: string
    }>
  }>
  setItems: (items: ReadonlyArray<VaultWireItem>) => void
  setLastStatus: (s: VaultStatusAck | null) => void
  setSync: (s: VaultSyncWire | null) => void
  setDisabled: (d: boolean) => void
  dispose: () => void
}

const mountSync = (
  initialItems: ReadonlyArray<VaultWireItem> = [],
  initialSync: VaultSyncWire | null = null,
  initialStatus: VaultStatusAck | null = null,
  initialDisabled = false,
): SyncRig => {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const [items, setItems] = createSignal<ReadonlyArray<VaultWireItem>>(initialItems)
  const [sync, setSync] = createSignal<VaultSyncWire | null>(initialSync)
  const [lastStatus, setLastStatus] = createSignal<VaultStatusAck | null>(initialStatus)
  const [disabled, setDisabled] = createSignal(initialDisabled)
  const putCalls: SyncRig["putCalls"] = []
  const deleteCalls: SyncRig["deleteCalls"] = []
  const syncConfigCalls: SyncRig["syncConfigCalls"] = []
  const importCalls: SyncRig["importCalls"] = []

  const dispose = render(
    () => (
      <VaultPanel
        items={items()}
        sync={sync()}
        lastStatus={lastStatus()}
        disabled={disabled()}
        onPut={(p) => putCalls.push(p as never)}
        onDelete={(p) => deleteCalls.push(p)}
        onSyncConfig={(p) => syncConfigCalls.push(p)}
        onImport={(p) => importCalls.push(p as never)}
      />
    ),
    container,
  )
  return {
    container,
    putCalls,
    deleteCalls,
    syncConfigCalls,
    importCalls,
    setItems,
    setLastStatus,
    setSync,
    setDisabled,
    dispose: () => {
      dispose()
      container.remove()
    },
  }
}

const openSyncSection = (container: HTMLElement) => {
  const btn = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("1Password Sync"),
  )
  if (!btn) throw new Error("Sync toggle button not found")
  btn.click()
}

const type = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
  el.value = value
  el.dispatchEvent(new Event("input", { bubbles: true }))
}

describe("VaultPanel sync section — renders from props.sync", () => {
  it("shows sync section toggle button", () => {
    const rig = mountSync()
    try {
      expect(rig.container.textContent).toContain("1Password Sync")
    } finally {
      rig.dispose()
    }
  })

  it("shows 'on' badge when sync is enabled", () => {
    const rig = mountSync(
      [],
      { enabled: true, opLabel: "MY_TOKEN", opVault: "Luna", lastSyncedAt: null, lastError: null, pollSeconds: 300 },
    )
    try {
      const badge = rig.container.querySelector(".vault-badge-synced")
      expect(badge).not.toBeNull()
      expect(badge!.textContent).toBe("on")
    } finally {
      rig.dispose()
    }
  })

  it("shows last-synced relative time when lastSyncedAt is present", () => {
    const now = Date.now()
    const rig = mountSync(
      [],
      {
        enabled: true,
        opLabel: "MY_TOKEN",
        opVault: "Luna",
        lastSyncedAt: now - 5 * 60_000,
        lastError: null,
        pollSeconds: 300,
      },
    )
    try {
      expect(rig.container.textContent).toContain("5 minutes ago")
    } finally {
      rig.dispose()
    }
  })

  it("shows lastError in red when present", () => {
    const rig = mountSync(
      [],
      {
        enabled: false,
        opLabel: null,
        opVault: null,
        lastSyncedAt: null,
        lastError: "op CLI not found",
        pollSeconds: 300,
      },
    )
    try {
      openSyncSection(rig.container)
      // Error text rendered via text content (not innerHTML)
      expect(rig.container.textContent).toContain("op CLI not found")
      const errEl = rig.container.querySelector(".vault-sync-error")
      expect(errEl).not.toBeNull()
    } finally {
      rig.dispose()
    }
  })

  it("does NOT show lastError when null", () => {
    const rig = mountSync(
      [],
      { enabled: false, opLabel: null, opVault: null, lastSyncedAt: null, lastError: null, pollSeconds: 300 },
    )
    try {
      openSyncSection(rig.container)
      expect(rig.container.querySelector(".vault-sync-error")).toBeNull()
    } finally {
      rig.dispose()
    }
  })
})

describe("VaultPanel sync section — datalist from op-token items", () => {
  it("populates datalist with labels from op-token items", () => {
    const items = [
      makeOpTokenItem("MAIN_TOKEN"),
      makeOpTokenItem("BACKUP_TOKEN"),
      makeItem({ id: "env-item", kind: "env-secret", ref: "env:MY_KEY" }),
    ]
    const rig = mountSync(items)
    try {
      openSyncSection(rig.container)
      const datalist = rig.container.querySelector("#vault-op-labels")
      expect(datalist).not.toBeNull()
      const options = [...datalist!.querySelectorAll("option")]
      const values = options.map((o) => (o as HTMLOptionElement).value)
      expect(values).toContain("MAIN_TOKEN")
      expect(values).toContain("BACKUP_TOKEN")
      // env-secret item should NOT appear
      expect(values).not.toContain("MY_KEY")
    } finally {
      rig.dispose()
    }
  })

  it("datalist is empty when no op-token items exist", () => {
    const rig = mountSync([makeItem()])
    try {
      openSyncSection(rig.container)
      const datalist = rig.container.querySelector("#vault-op-labels")
      expect(datalist).not.toBeNull()
      const options = [...datalist!.querySelectorAll("option")]
      expect(options).toHaveLength(0)
    } finally {
      rig.dispose()
    }
  })
})

describe("VaultPanel sync section — save sends correct frame", () => {
  it("save sends vault-sync-config frame with correct fields", () => {
    const rig = mountSync()
    try {
      openSyncSection(rig.container)

      // Enable the checkbox
      const checkbox = rig.container.querySelector(".vault-sync-checkbox") as HTMLInputElement
      checkbox.checked = true
      checkbox.dispatchEvent(new Event("change", { bubbles: true }))

      // Set label
      const labelInput = rig.container.querySelector("#vault-sync-label") as HTMLInputElement
      type(labelInput, "MY_TOKEN")

      // Set vault name
      const vaultInput = rig.container.querySelector("#vault-sync-vault") as HTMLInputElement
      type(vaultInput, "MyVault")

      // Set poll seconds
      const pollInput = rig.container.querySelector("#vault-sync-poll") as HTMLInputElement
      type(pollInput, "120")

      // Save
      const saveBtn = [...rig.container.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Save sync settings",
      )!
      saveBtn.click()

      expect(rig.syncConfigCalls).toHaveLength(1)
      const call = rig.syncConfigCalls[0]!
      expect(call.enabled).toBe(true)
      expect(call.opLabel).toBe("MY_TOKEN")
      expect(call.opVault).toBe("MyVault")
      expect(call.pollSeconds).toBe(120)
      expect(call.requestId).toMatch(/^vlt_/)
    } finally {
      rig.dispose()
    }
  })

  it("save shows 'Saving…' while a sync-config ack is pending", () => {
    const rig = mountSync()
    try {
      openSyncSection(rig.container)
      const saveBtn = [...rig.container.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Save sync settings",
      )!
      saveBtn.click()
      // Immediately after click, before ack arrives, button should show Saving…
      expect(saveBtn.textContent?.trim()).toBe("Saving…")
    } finally {
      rig.dispose()
    }
  })
})

describe("VaultPanel import — disabled when sync is off", () => {
  it("shows explainer and disabled button when sync is not enabled", () => {
    const rig = mountSync(
      [],
      { enabled: false, opLabel: null, opVault: null, lastSyncedAt: null, lastError: null, pollSeconds: 300 },
    )
    try {
      openSyncSection(rig.container)
      // Explainer text should be present
      const text = rig.container.textContent!
      expect(text).toContain("Enable 1Password sync above to import Apple Passwords")
      // The file input should NOT be present (it's in the enabled branch)
      const fileInput = rig.container.querySelector('input[type="file"]')
      expect(fileInput).toBeNull()
      // There should be a disabled "Choose file" button
      const disabledBtn = [...rig.container.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Choose file" && b.disabled,
      )
      expect(disabledBtn).not.toBeUndefined()
    } finally {
      rig.dispose()
    }
  })

  it("shows file input when sync IS enabled", () => {
    const rig = mountSync(
      [],
      { enabled: true, opLabel: "MY_TOKEN", opVault: "Luna", lastSyncedAt: null, lastError: null, pollSeconds: 300 },
    )
    try {
      openSyncSection(rig.container)
      const fileInput = rig.container.querySelector('input[type="file"]')
      expect(fileInput).not.toBeNull()
    } finally {
      rig.dispose()
    }
  })
})

describe("VaultPanel import — preview shows titles never passwords", () => {
  it("after file parse shows title preview but never passwords", async () => {
    const rig = mountSync(
      [],
      { enabled: true, opLabel: "MY_TOKEN", opVault: "Luna", lastSyncedAt: null, lastError: null, pollSeconds: 300 },
    )
    try {
      openSyncSection(rig.container)

      const fileInput = rig.container.querySelector('input[type="file"]') as HTMLInputElement
      expect(fileInput).not.toBeNull()

      // Simulate file selection by directly calling the onChange handler approach:
      // We use a synthetic File + FileReader mock.
      const csvContent = [
        "Title,URL,Username,Password,Notes,OTPAuth",
        "Site Alpha,https://alpha.com,user1,SECRET_PASS_1,,",
        "Site Beta,https://beta.com,user2,SECRET_PASS_2,,",
        "Site Gamma,https://gamma.com,user3,SECRET_PASS_3,,",
      ].join("\n")

      // Mock FileReader
      const originalFileReader = globalThis.FileReader
      class MockFileReader {
        result: string | null = null
        onload: (() => void) | null = null
        readAsText(file: Blob) {
          // Synchronously set result and trigger onload
          this.result = csvContent
          setTimeout(() => this.onload?.(), 0)
        }
      }
      ;(globalThis as unknown as Record<string, unknown>)["FileReader"] = MockFileReader

      // Trigger file change
      const file = new File([csvContent], "passwords.csv", { type: "text/csv" })
      Object.defineProperty(fileInput, "files", {
        value: [file],
        configurable: true,
      })
      fileInput.dispatchEvent(new Event("change", { bubbles: true }))

      // Wait for async FileReader
      await new Promise((r) => setTimeout(r, 20))

      // Preview count should be present
      expect(rig.container.textContent).toContain("3 passwords ready to import")
      // Titles should appear
      expect(rig.container.textContent).toContain("Site Alpha")
      expect(rig.container.textContent).toContain("Site Beta")
      expect(rig.container.textContent).toContain("Site Gamma")
      // Passwords must NOT appear anywhere in the DOM
      expect(rig.container.textContent).not.toContain("SECRET_PASS_1")
      expect(rig.container.textContent).not.toContain("SECRET_PASS_2")
      expect(rig.container.textContent).not.toContain("SECRET_PASS_3")
      // Usernames must NOT appear
      expect(rig.container.textContent).not.toContain("user1")
      expect(rig.container.textContent).not.toContain("user2")
      expect(rig.container.textContent).not.toContain("user3")

      ;(globalThis as unknown as Record<string, unknown>)["FileReader"] = originalFileReader
    } finally {
      rig.dispose()
    }
  })

  it("shows first 5 titles + 'and N more' for large imports", async () => {
    const rig = mountSync(
      [],
      { enabled: true, opLabel: "MY_TOKEN", opVault: "Luna", lastSyncedAt: null, lastError: null, pollSeconds: 300 },
    )
    try {
      openSyncSection(rig.container)

      const lines = ["Title,URL,Username,Password,Notes,OTPAuth"]
      for (let i = 1; i <= 8; i++) {
        lines.push(`Site ${i},https://site${i}.com,user${i},pass${i},,`)
      }
      const csvContent = lines.join("\n")

      const originalFileReader = globalThis.FileReader
      class MockFileReader {
        result: string | null = null
        onload: (() => void) | null = null
        readAsText(_file: Blob) {
          this.result = csvContent
          setTimeout(() => this.onload?.(), 0)
        }
      }
      ;(globalThis as unknown as Record<string, unknown>)["FileReader"] = MockFileReader

      const fileInput = rig.container.querySelector('input[type="file"]') as HTMLInputElement
      const file = new File([csvContent], "passwords.csv", { type: "text/csv" })
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true })
      fileInput.dispatchEvent(new Event("change", { bubbles: true }))
      await new Promise((r) => setTimeout(r, 20))

      // Should show first 5 titles
      expect(rig.container.textContent).toContain("Site 1")
      expect(rig.container.textContent).toContain("Site 5")
      // Should NOT directly show Site 6-8 as title list items
      expect(rig.container.textContent).toContain("… and 3 more")
      // Count
      expect(rig.container.textContent).toContain("8 passwords ready to import")

      ;(globalThis as unknown as Record<string, unknown>)["FileReader"] = originalFileReader
    } finally {
      rig.dispose()
    }
  })

  it("shows large-import warning for > 80 rows", async () => {
    const rig = mountSync(
      [],
      { enabled: true, opLabel: "MY_TOKEN", opVault: "Luna", lastSyncedAt: null, lastError: null, pollSeconds: 300 },
    )
    try {
      openSyncSection(rig.container)

      const lines = ["Title,URL,Username,Password,Notes,OTPAuth"]
      for (let i = 1; i <= 85; i++) {
        lines.push(`Site ${i},https://site${i}.com,user${i},pass${i},,`)
      }
      const csvContent = lines.join("\n")

      const originalFileReader = globalThis.FileReader
      class MockFileReader {
        result: string | null = null
        onload: (() => void) | null = null
        readAsText(_file: Blob) {
          this.result = csvContent
          setTimeout(() => this.onload?.(), 0)
        }
      }
      ;(globalThis as unknown as Record<string, unknown>)["FileReader"] = MockFileReader

      const fileInput = rig.container.querySelector('input[type="file"]') as HTMLInputElement
      const file = new File([csvContent], "passwords.csv", { type: "text/csv" })
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true })
      fileInput.dispatchEvent(new Event("change", { bubbles: true }))
      await new Promise((r) => setTimeout(r, 20))

      expect(rig.container.textContent).toContain("Large import")
      expect(rig.container.textContent).toContain("~100/hour")

      ;(globalThis as unknown as Record<string, unknown>)["FileReader"] = originalFileReader
    } finally {
      rig.dispose()
    }
  })
})

describe("VaultPanel import — chunking ≤5 with sequential acks", () => {
  it("sends rows in chunks of ≤5, waits for each ack before next chunk", async () => {
    const rig = mountSync(
      [],
      { enabled: true, opLabel: "MY_TOKEN", opVault: "Luna", lastSyncedAt: null, lastError: null, pollSeconds: 300 },
    )
    try {
      openSyncSection(rig.container)

      // Build 10 rows → 2 chunks of 5 (IMPORT_CHUNK_SIZE = 5)
      const lines = ["Title,URL,Username,Password,Notes,OTPAuth"]
      for (let i = 1; i <= 10; i++) {
        lines.push(`Site ${i},https://site${i}.com,user${i},pass${i},,`)
      }
      const csvContent = lines.join("\n")

      const originalFileReader = globalThis.FileReader
      class MockFileReader {
        result: string | null = null
        onload: (() => void) | null = null
        readAsText(_file: Blob) {
          this.result = csvContent
          setTimeout(() => this.onload?.(), 0)
        }
      }
      ;(globalThis as unknown as Record<string, unknown>)["FileReader"] = MockFileReader

      const fileInput = rig.container.querySelector('input[type="file"]') as HTMLInputElement
      const file = new File([csvContent], "passwords.csv", { type: "text/csv" })
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true })
      fileInput.dispatchEvent(new Event("change", { bubbles: true }))
      await new Promise((r) => setTimeout(r, 20))

      // Expect 10 passwords ready to import
      expect(rig.container.textContent).toContain("10 passwords ready to import")

      // Click confirm import
      const confirmBtn = [...rig.container.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Confirm import",
      )!
      confirmBtn.click()

      // At this point, exactly 1 import call should have been made (first chunk of 5)
      // before we supply the ack
      await new Promise((r) => setTimeout(r, 30))
      expect(rig.importCalls.length).toBe(1)
      expect(rig.importCalls[0]!.items.length).toBe(5)

      // Supply ack for first chunk
      const reqId1 = rig.importCalls[0]!.requestId
      rig.setLastStatus({ requestId: reqId1, ok: true, message: "ok" })

      // Wait for second chunk to be sent
      await new Promise((r) => setTimeout(r, 100))
      expect(rig.importCalls.length).toBe(2)
      expect(rig.importCalls[1]!.items.length).toBe(5)

      // Supply ack for second chunk
      const reqId2 = rig.importCalls[1]!.requestId
      rig.setLastStatus({ requestId: reqId2, ok: true, message: "ok" })

      // Wait for completion
      await new Promise((r) => setTimeout(r, 50))

      // Should show done message
      expect(rig.container.textContent).toContain("Done — you can delete the exported CSV file now")

      ;(globalThis as unknown as Record<string, unknown>)["FileReader"] = originalFileReader
    } finally {
      rig.dispose()
    }
  })

  it("each chunk contains ≤5 items (IMPORT_CHUNK_SIZE constant)", async () => {
    const rig = mountSync(
      [],
      { enabled: true, opLabel: "MY_TOKEN", opVault: "Luna", lastSyncedAt: null, lastError: null, pollSeconds: 300 },
    )
    try {
      openSyncSection(rig.container)

      // Build exactly 5 rows → 1 chunk of 5 (IMPORT_CHUNK_SIZE = 5)
      const lines = ["Title,URL,Username,Password,Notes,OTPAuth"]
      for (let i = 1; i <= 5; i++) {
        lines.push(`Site ${i},https://site${i}.com,user${i},pass${i},,`)
      }
      const csvContent = lines.join("\n")

      const originalFileReader = globalThis.FileReader
      class MockFileReader {
        result: string | null = null
        onload: (() => void) | null = null
        readAsText(_file: Blob) {
          this.result = csvContent
          setTimeout(() => this.onload?.(), 0)
        }
      }
      ;(globalThis as unknown as Record<string, unknown>)["FileReader"] = MockFileReader

      const fileInput = rig.container.querySelector('input[type="file"]') as HTMLInputElement
      const file = new File([csvContent], "passwords.csv", { type: "text/csv" })
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true })
      fileInput.dispatchEvent(new Event("change", { bubbles: true }))
      await new Promise((r) => setTimeout(r, 20))

      const confirmBtn = [...rig.container.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Confirm import",
      )!
      confirmBtn.click()

      await new Promise((r) => setTimeout(r, 30))
      expect(rig.importCalls.length).toBe(1)
      // Exactly 5 items in one chunk
      expect(rig.importCalls[0]!.items.length).toBe(5)

      // Ack the chunk
      rig.setLastStatus({ requestId: rig.importCalls[0]!.requestId, ok: true, message: "ok" })
      await new Promise((r) => setTimeout(r, 50))

      // No second chunk — done
      expect(rig.importCalls.length).toBe(1)
      expect(rig.container.textContent).toContain("Done")

      ;(globalThis as unknown as Record<string, unknown>)["FileReader"] = originalFileReader
    } finally {
      rig.dispose()
    }
  })
})

describe("VaultPanel import — abort on failed chunk", () => {
  it("stops importing and shows error message when a chunk fails", async () => {
    const rig = mountSync(
      [],
      { enabled: true, opLabel: "MY_TOKEN", opVault: "Luna", lastSyncedAt: null, lastError: null, pollSeconds: 300 },
    )
    try {
      openSyncSection(rig.container)

      const lines = ["Title,URL,Username,Password,Notes,OTPAuth"]
      for (let i = 1; i <= 25; i++) {
        lines.push(`Site ${i},https://site${i}.com,user${i},pass${i},,`)
      }
      const csvContent = lines.join("\n")

      const originalFileReader = globalThis.FileReader
      class MockFileReader {
        result: string | null = null
        onload: (() => void) | null = null
        readAsText(_file: Blob) {
          this.result = csvContent
          setTimeout(() => this.onload?.(), 0)
        }
      }
      ;(globalThis as unknown as Record<string, unknown>)["FileReader"] = MockFileReader

      const fileInput = rig.container.querySelector('input[type="file"]') as HTMLInputElement
      const file = new File([csvContent], "passwords.csv", { type: "text/csv" })
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true })
      fileInput.dispatchEvent(new Event("change", { bubbles: true }))
      await new Promise((r) => setTimeout(r, 20))

      const confirmBtn = [...rig.container.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Confirm import",
      )!
      confirmBtn.click()

      await new Promise((r) => setTimeout(r, 30))
      expect(rig.importCalls.length).toBe(1)

      // Fail the first chunk
      const reqId1 = rig.importCalls[0]!.requestId
      rig.setLastStatus({
        requestId: reqId1,
        ok: false,
        message: "1Password vault not accessible",
      })

      await new Promise((r) => setTimeout(r, 100))

      // No second chunk should have been sent
      expect(rig.importCalls.length).toBe(1)

      // Error message should be shown
      expect(rig.container.textContent).toContain("Import stopped after 0 of 25")
      expect(rig.container.textContent).toContain("1Password vault not accessible")

      // "Done" message should NOT appear
      expect(rig.container.textContent).not.toContain("Done — you can delete")

      ;(globalThis as unknown as Record<string, unknown>)["FileReader"] = originalFileReader
    } finally {
      rig.dispose()
    }
  })
})

describe("VaultPanel import — state wiped after completion", () => {
  it("file input, import rows, and progress cleared after successful import", async () => {
    const rig = mountSync(
      [],
      { enabled: true, opLabel: "MY_TOKEN", opVault: "Luna", lastSyncedAt: null, lastError: null, pollSeconds: 300 },
    )
    try {
      openSyncSection(rig.container)

      const lines = ["Title,URL,Username,Password,Notes,OTPAuth", "Site 1,url,user,pass1,,"]
      const csvContent = lines.join("\n")

      const originalFileReader = globalThis.FileReader
      class MockFileReader {
        result: string | null = null
        onload: (() => void) | null = null
        readAsText(_file: Blob) {
          this.result = csvContent
          setTimeout(() => this.onload?.(), 0)
        }
      }
      ;(globalThis as unknown as Record<string, unknown>)["FileReader"] = MockFileReader

      const fileInput = rig.container.querySelector('input[type="file"]') as HTMLInputElement
      const file = new File([csvContent], "passwords.csv", { type: "text/csv" })
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true })
      fileInput.dispatchEvent(new Event("change", { bubbles: true }))
      await new Promise((r) => setTimeout(r, 20))

      // Should have preview
      expect(rig.container.textContent).toContain("1 password ready to import")

      const confirmBtn = [...rig.container.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Confirm import",
      )!
      confirmBtn.click()
      await new Promise((r) => setTimeout(r, 30))

      // Supply successful ack
      rig.setLastStatus({ requestId: rig.importCalls[0]!.requestId, ok: true, message: "ok" })
      await new Promise((r) => setTimeout(r, 50))

      // Done state
      expect(rig.container.textContent).toContain("Done — you can delete the exported CSV file now")

      // Preview titles should be gone (state wiped)
      expect(rig.container.textContent).not.toContain("1 password ready to import")
      expect(rig.container.textContent).not.toContain("Site 1")

      // No password should appear anywhere
      expect(rig.container.textContent).not.toContain("pass1")

      ;(globalThis as unknown as Record<string, unknown>)["FileReader"] = originalFileReader
    } finally {
      rig.dispose()
    }
  })
})

// ── Item 1: pollSeconds seeds the poll-interval field ────────────────────────

describe("VaultPanel sync section — pollSeconds round-trip from props.sync", () => {
  it("seeds the poll-interval input from props.sync.pollSeconds on first render", () => {
    const rig = mountSync(
      [],
      { enabled: true, opLabel: "MY_TOKEN", opVault: "Luna", lastSyncedAt: null, lastError: null, pollSeconds: 120 },
    )
    try {
      openSyncSection(rig.container)
      const pollInput = rig.container.querySelector("#vault-sync-poll") as HTMLInputElement
      expect(pollInput).not.toBeNull()
      expect(pollInput.value).toBe("120")
    } finally {
      rig.dispose()
    }
  })

  it("save frame includes pollSeconds reflecting the seeded value", () => {
    const rig = mountSync(
      [],
      { enabled: true, opLabel: "MY_TOKEN", opVault: "Luna", lastSyncedAt: null, lastError: null, pollSeconds: 180 },
    )
    try {
      openSyncSection(rig.container)
      const saveBtn = [...rig.container.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Save sync settings",
      )!
      saveBtn.click()
      expect(rig.syncConfigCalls).toHaveLength(1)
      expect(rig.syncConfigCalls[0]!.pollSeconds).toBe(180)
    } finally {
      rig.dispose()
    }
  })
})

// ── Item 2: sync-form no-clobber on vault-list broadcast ─────────────────────

describe("VaultPanel sync section — sync-form not clobbered by re-broadcast", () => {
  it("user edits to the sync form survive a new props.sync delivery while section is open", () => {
    const rig = mountSync(
      [],
      { enabled: false, opLabel: "ORIG", opVault: "OrigVault", lastSyncedAt: null, lastError: null, pollSeconds: 300 },
    )
    try {
      openSyncSection(rig.container)

      // Verify initial seed
      const labelInput = rig.container.querySelector("#vault-sync-label") as HTMLInputElement
      expect(labelInput.value).toBe("ORIG")

      // User edits the label field
      type(labelInput, "EDITED_LABEL")
      expect(labelInput.value).toBe("EDITED_LABEL")

      // A new vault-list broadcast arrives with different values
      rig.setSync({
        enabled: true,
        opLabel: "NEW_FROM_SERVER",
        opVault: "NewVault",
        lastSyncedAt: null,
        lastError: null,
        pollSeconds: 600,
      })

      // The label input must NOT have been overwritten — user edit survives
      expect(labelInput.value).toBe("EDITED_LABEL")
    } finally {
      rig.dispose()
    }
  })

  it("re-seeds after a successful sync-save ack so saved state reflects", () => {
    const rig = mountSync(
      [],
      { enabled: false, opLabel: "ORIG", opVault: "Luna", lastSyncedAt: null, lastError: null, pollSeconds: 300 },
    )
    try {
      openSyncSection(rig.container)

      // Save the current form
      const saveBtn = [...rig.container.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Save sync settings",
      )!
      saveBtn.click()
      const reqId = rig.syncConfigCalls[0]!.requestId

      // Server acks the save as ok
      rig.setLastStatus({ requestId: reqId, ok: true, message: "1Password sync enabled." })

      // Server then sends a new vault-list with updated pollSeconds
      rig.setSync({
        enabled: true,
        opLabel: "UPDATED_LABEL",
        opVault: "Luna",
        lastSyncedAt: null,
        lastError: null,
        pollSeconds: 120,
      })

      // The poll input should now reflect the server's updated value
      const pollInput = rig.container.querySelector("#vault-sync-poll") as HTMLInputElement
      expect(pollInput.value).toBe("120")
    } finally {
      rig.dispose()
    }
  })
})

// ── Item 4: import-pending lockout ───────────────────────────────────────────

describe("VaultPanel import — sync save button disabled during import", () => {
  it("sync save button is disabled while an import is in progress", async () => {
    const rig = mountSync(
      [],
      { enabled: true, opLabel: "MY_TOKEN", opVault: "Luna", lastSyncedAt: null, lastError: null, pollSeconds: 300 },
    )
    try {
      openSyncSection(rig.container)

      const lines = ["Title,URL,Username,Password,Notes,OTPAuth", "Site 1,url,user,pass1,,"]
      const csvContent = lines.join("\n")

      const originalFileReader = globalThis.FileReader
      class MockFileReader {
        result: string | null = null
        onload: (() => void) | null = null
        readAsText(_file: Blob) {
          this.result = csvContent
          setTimeout(() => this.onload?.(), 0)
        }
      }
      ;(globalThis as unknown as Record<string, unknown>)["FileReader"] = MockFileReader

      const fileInput = rig.container.querySelector('input[type="file"]') as HTMLInputElement
      const file = new File([csvContent], "passwords.csv", { type: "text/csv" })
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true })
      fileInput.dispatchEvent(new Event("change", { bubbles: true }))
      await new Promise((r) => setTimeout(r, 20))

      // Start the import
      const confirmBtn = [...rig.container.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Confirm import",
      )!
      confirmBtn.click()
      await new Promise((r) => setTimeout(r, 30))

      // While import is in-flight, the sync Save button must be disabled
      const saveBtn = [...rig.container.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Save sync settings",
      )!
      expect(saveBtn.disabled).toBe(true)

      ;(globalThis as unknown as Record<string, unknown>)["FileReader"] = originalFileReader
    } finally {
      rig.dispose()
    }
  })
})

// ── Item 5: abort honesty — clearImportRowsAndFile FIRST ─────────────────────

describe("VaultPanel import — abort honesty on connection loss", () => {
  it("connection loss mid-import: rows wiped, abort message visible, no further chunks", async () => {
    const rig = mountSync(
      [],
      { enabled: true, opLabel: "MY_TOKEN", opVault: "Luna", lastSyncedAt: null, lastError: null, pollSeconds: 300 },
    )
    try {
      openSyncSection(rig.container)

      // Build 10 rows → 2 chunks of 5
      const lines = ["Title,URL,Username,Password,Notes,OTPAuth"]
      for (let i = 1; i <= 10; i++) {
        lines.push(`Site ${i},url,user${i},pass${i},,`)
      }
      const csvContent = lines.join("\n")

      const originalFileReader = globalThis.FileReader
      class MockFileReader {
        result: string | null = null
        onload: (() => void) | null = null
        readAsText(_file: Blob) {
          this.result = csvContent
          setTimeout(() => this.onload?.(), 0)
        }
      }
      ;(globalThis as unknown as Record<string, unknown>)["FileReader"] = MockFileReader

      const fileInput = rig.container.querySelector('input[type="file"]') as HTMLInputElement
      const file = new File([csvContent], "passwords.csv", { type: "text/csv" })
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true })
      fileInput.dispatchEvent(new Event("change", { bubbles: true }))
      await new Promise((r) => setTimeout(r, 20))

      // Click confirm — starts first chunk
      const confirmBtn = [...rig.container.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Confirm import",
      )!
      confirmBtn.click()
      await new Promise((r) => setTimeout(r, 30))
      expect(rig.importCalls.length).toBe(1)

      // Simulate connection drop BEFORE acking the first chunk
      rig.setDisabled(true)

      // Supply ack AFTER disable (should be ignored — import already aborted)
      rig.setLastStatus({ requestId: rig.importCalls[0]!.requestId, ok: true, message: "ok" })
      await new Promise((r) => setTimeout(r, 100))

      // No second chunk should have been sent
      expect(rig.importCalls.length).toBe(1)

      // Abort message must be visible
      expect(rig.container.textContent).toContain("Import aborted")

      // The title preview rows must be gone (rows wiped)
      expect(rig.container.textContent).not.toContain("Site 1")

      ;(globalThis as unknown as Record<string, unknown>)["FileReader"] = originalFileReader
    } finally {
      rig.dispose()
    }
  })
})

// ── Item 6: password trailing-space preserved ─────────────────────────────────

describe("parseAppleCsv — password trim", () => {
  it("preserves a password with a trailing space (does not trim password)", () => {
    const csv = `Title,URL,Username,Password,Notes,OTPAuth
Site A,url,user,"pa$$word ",note,`
    const rows = parseAppleCsv(csv)
    expect(rows).toHaveLength(1)
    // The trailing space must be preserved exactly
    expect(rows[0]!.password).toBe("pa$$word ")
  })

  it("preserves a password with a leading space", () => {
    const csv = `Title,URL,Username,Password,Notes
Site B,url,user," secretval",`
    const rows = parseAppleCsv(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.password).toBe(" secretval")
  })

  it("still drops rows where password is all whitespace (password.trim() === '')", () => {
    const csv = `Title,URL,Username,Password,Notes
Site C,url,user,"   ",`
    const rows = parseAppleCsv(csv)
    expect(rows).toHaveLength(0)
  })

  it("still trims the title field", () => {
    const csv = `Title,URL,Username,Password,Notes
"  Trimmed Site  ",url,user,pa$$,`
    const rows = parseAppleCsv(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe("Trimmed Site")
  })
})

// ── Item 7: BOM stripping ─────────────────────────────────────────────────────

describe("parseAppleCsv — BOM stripping", () => {
  it("parses correctly when file has a leading UTF-8 BOM (U+FEFF)", () => {
    // U+FEFF prefixed to a valid Apple Passwords CSV
    const bom = "﻿"
    const csv = bom + `Title,URL,Username,Password,Notes,OTPAuth
My BOM Site,https://example.com,user,bom_pass,,`
    const rows = parseAppleCsv(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe("My BOM Site")
    expect(rows[0]!.password).toBe("bom_pass")
  })

  it("handles BOM with CRLF line endings", () => {
    const bom = "﻿"
    const csv = bom + "Title,URL,Username,Password,Notes,OTPAuth\r\nBOM CRLF,url,user,crlf_pass,,\r\n"
    const rows = parseAppleCsv(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe("BOM CRLF")
    expect(rows[0]!.password).toBe("crlf_pass")
  })

  it("returns empty array for a BOM-only file (no header)", () => {
    const bom = "﻿"
    expect(parseAppleCsv(bom)).toHaveLength(0)
  })

  it("parses correctly with no BOM (regression guard)", () => {
    const csv = `Title,URL,Username,Password,Notes
No BOM Site,url,user,no_bom_pass,`
    const rows = parseAppleCsv(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe("No BOM Site")
  })
})

// ── C1: collapse sync section clears parsed rows + file ──────────────────────

describe("VaultPanel import — C1: rows cleared on sync-section collapse", () => {
  it("parsed CSV rows and preview state are cleared when sync section is collapsed", async () => {
    const rig = mountSync(
      [],
      { enabled: true, opLabel: "MY_TOKEN", opVault: "Luna", lastSyncedAt: null, lastError: null, pollSeconds: 300 },
    )
    try {
      openSyncSection(rig.container)

      const csvContent = [
        "Title,URL,Username,Password,Notes,OTPAuth",
        "Alpha Site,https://alpha.com,user1,pass_alpha,,",
        "Beta Site,https://beta.com,user2,pass_beta,,",
      ].join("\n")

      const originalFileReader = globalThis.FileReader
      class MockFileReader {
        result: string | null = null
        onload: (() => void) | null = null
        readAsText(_file: Blob) {
          this.result = csvContent
          setTimeout(() => this.onload?.(), 0)
        }
      }
      ;(globalThis as unknown as Record<string, unknown>)["FileReader"] = MockFileReader

      const fileInput = rig.container.querySelector('input[type="file"]') as HTMLInputElement
      const file = new File([csvContent], "passwords.csv", { type: "text/csv" })
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true })
      fileInput.dispatchEvent(new Event("change", { bubbles: true }))

      // Wait for async FileReader
      await new Promise((r) => setTimeout(r, 20))

      // Verify preview is shown before collapse
      expect(rig.container.textContent).toContain("2 passwords ready to import")
      expect(rig.container.textContent).toContain("Alpha Site")
      expect(rig.container.textContent).toContain("Beta Site")

      // Collapse the sync section by clicking the toggle
      const toggleBtn = [...rig.container.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("1Password Sync"),
      )!
      toggleBtn.click()

      // Re-open section to verify rows were cleared (not just hidden)
      toggleBtn.click()
      await new Promise((r) => setTimeout(r, 10))

      // Preview titles must be gone (rows wiped, not just hidden)
      expect(rig.container.textContent).not.toContain("Alpha Site")
      expect(rig.container.textContent).not.toContain("Beta Site")
      expect(rig.container.textContent).not.toContain("2 passwords ready to import")
      // Passwords must never have appeared, and must remain absent
      expect(rig.container.textContent).not.toContain("pass_alpha")
      expect(rig.container.textContent).not.toContain("pass_beta")

      ;(globalThis as unknown as Record<string, unknown>)["FileReader"] = originalFileReader
    } finally {
      rig.dispose()
    }
  })
})

// ── C2: safety timer fake-timer test ─────────────────────────────────────────

describe("VaultPanel import — C2: safety timer fires after 120s without ack", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("times out after 120s, shows abort message, no password/title in DOM, onImport called once", async () => {
    // We need to mount with sync enabled and confirm a 1-chunk import.
    // The rig uses a real lastStatus signal — we will NOT ack, so the
    // safety timer should fire after CHUNK_ACK_TIMEOUT_MS = 120 000 ms.
    const rig = mountSync(
      [],
      { enabled: true, opLabel: "MY_TOKEN", opVault: "Luna", lastSyncedAt: null, lastError: null, pollSeconds: 300 },
    )
    try {
      openSyncSection(rig.container)

      const csvContent = [
        "Title,URL,Username,Password,Notes,OTPAuth",
        "Timeout Site,https://timeout.com,user1,SECRET_TIMEOUT_PASS,,",
      ].join("\n")

      // Patch FileReader to deliver synchronously after a 0ms timeout
      const originalFileReader = globalThis.FileReader
      class MockFileReader {
        result: string | null = null
        onload: (() => void) | null = null
        readAsText(_file: Blob) {
          this.result = csvContent
          // Use the real setTimeout (fake timers are active so we need a microtask)
          Promise.resolve().then(() => this.onload?.())
        }
      }
      ;(globalThis as unknown as Record<string, unknown>)["FileReader"] = MockFileReader

      const fileInput = rig.container.querySelector('input[type="file"]') as HTMLInputElement
      const file = new File([csvContent], "passwords.csv", { type: "text/csv" })
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true })
      fileInput.dispatchEvent(new Event("change", { bubbles: true }))

      // Flush the microtask that calls onload
      await Promise.resolve()
      await Promise.resolve()

      // Preview should be visible
      expect(rig.container.textContent).toContain("1 password ready to import")

      // Click confirm import — starts the first (only) chunk
      const confirmBtn = [...rig.container.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Confirm import",
      )!
      confirmBtn.click()

      // Drain promises so runImport reaches the ackPromise await
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      // onImport should have been called exactly once (the first chunk)
      expect(rig.importCalls.length).toBe(1)

      // Advance fake timers: first flush the 50ms poll interval repeatedly,
      // then advance past CHUNK_ACK_TIMEOUT_MS (120 000 ms).
      // We advance in two steps: past the poll tick, then the full 2-minute timeout.
      vi.advanceTimersByTime(120_000 + 100)

      // The safety timer resolves the ackPromise with ok:false
      // Allow the microtask queue to flush (the async runImport continuation)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      // onImport was called exactly once — no retry after timeout
      expect(rig.importCalls.length).toBe(1)

      // The timed-out abort message should be visible
      const text = rig.container.textContent!
      expect(text).toMatch(/[Tt]imed?\s*out|Timed out/)

      // No credential or title text should remain in the DOM
      expect(text).not.toContain("Timeout Site")
      expect(text).not.toContain("SECRET_TIMEOUT_PASS")
      expect(text).not.toContain("1 password ready to import")

      ;(globalThis as unknown as Record<string, unknown>)["FileReader"] = originalFileReader
    } finally {
      rig.dispose()
    }
  })
})
