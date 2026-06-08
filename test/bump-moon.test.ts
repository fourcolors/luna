import { describe, expect, it } from "vitest"
import { checkSync, extractVersion, replaceVersion, VERSION_FILES } from "../scripts/bump-moon.ts"

const PKG_JSON = `{\n  "name": "ui-moon-tauri",\n  "version": "0.0.12",\n  "private": true\n}\n`
const TAURI_JSON = `{\n  "productName": "Luna Moon",\n  "version": "0.0.12",\n  "identifier": "ai.luna.moon"\n}\n`
// Cargo.toml: a top-of-line package version PLUS a dependency that also says version — only the package one must change.
const CARGO_TOML = `[package]\nname = "luna-moon"\nversion = "0.0.12"\nedition = "2021"\n\n[dependencies]\ntauri = { version = "2.0.0" }\n`

describe("extractVersion", () => {
  it("reads the version from JSON", () => {
    expect(extractVersion(PKG_JSON, "json")).toBe("0.0.12")
    expect(extractVersion(TAURI_JSON, "json")).toBe("0.0.12")
  })
  it("reads the [package] version from TOML, not a dependency's", () => {
    expect(extractVersion(CARGO_TOML, "toml")).toBe("0.0.12")
  })
  it("returns null when absent", () => {
    expect(extractVersion(`{"name":"x"}`, "json")).toBeNull()
  })
})

describe("replaceVersion", () => {
  it("bumps JSON in place and is re-readable", () => {
    const out = replaceVersion(PKG_JSON, "json", "0.1.0")
    expect(extractVersion(out, "json")).toBe("0.1.0")
    expect(out).toContain(`"name": "ui-moon-tauri"`) // other fields untouched
  })
  it("bumps ONLY the package version in TOML, leaving the dependency's 2.0.0", () => {
    const out = replaceVersion(CARGO_TOML, "toml", "0.1.0")
    expect(extractVersion(out, "toml")).toBe("0.1.0")
    expect(out).toContain(`tauri = { version = "2.0.0" }`) // dependency untouched
  })
  it("throws when there is no version field to replace", () => {
    expect(() => replaceVersion(`name = "x"\n`, "toml", "1.2.3")).toThrow()
  })
})

describe("checkSync", () => {
  const m = (a: string, b: string, c: string) =>
    new Map([
      [VERSION_FILES[0].path, a],
      [VERSION_FILES[1].path, b],
      [VERSION_FILES[2].path, c],
    ])

  it("ok when all three agree on a valid semver", () => {
    const res = checkSync(m(PKG_JSON, CARGO_TOML, TAURI_JSON))
    expect(res.ok).toBe(true)
    expect(res.distinct).toEqual(["0.0.12"])
  })
  it("FAILS on drift (the footgun this gate exists to catch)", () => {
    const drifted = CARGO_TOML.replace("0.0.12", "0.0.13")
    const res = checkSync(m(PKG_JSON, drifted, TAURI_JSON))
    expect(res.ok).toBe(false)
    expect([...res.distinct].sort()).toEqual(["0.0.12", "0.0.13"])
  })
  it("FAILS when a file is missing its version", () => {
    const res = checkSync(m(PKG_JSON, CARGO_TOML, `{"name":"x"}`))
    expect(res.ok).toBe(false)
  })
})
