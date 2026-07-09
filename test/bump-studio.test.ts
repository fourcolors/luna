import { describe, expect, it } from "vitest"
import { checkSync, extractVersion, replaceVersion, VERSION_FILES } from "../scripts/bump-studio.ts"

const PKG_JSON = `{\n  "name": "ui-studio-tauri",\n  "version": "0.0.12",\n  "private": true\n}\n`
const TAURI_JSON = `{\n  "productName": "Luna Studio",\n  "version": "0.0.12",\n  "identifier": "com.luna.studio"\n}\n`
// Cargo.toml: a top-of-line package version PLUS a dependency that also says version — only the package one must change.
const CARGO_TOML = `[package]\nname = "luna-studio"\nversion = "0.0.12"\nedition = "2021"\n\n[dependencies]\ntauri = { version = "2.0.0" }\n`
// Cargo.lock: hundreds of crate entries each with a `version = "..."`. Only the
// luna-studio-ui [[package]] block's version may move. The fixture sandwiches our
// crate between two decoys whose versions must stay put.
const CARGO_LOCK =
  `[[package]]\nname = "anyhow"\nversion = "1.0.86"\n\n` +
  `[[package]]\nname = "luna-studio-ui"\nversion = "0.0.12"\ndependencies = [\n "tauri",\n]\n\n` +
  `[[package]]\nname = "tauri"\nversion = "2.0.0"\n`

describe("extractVersion", () => {
  it("reads the version from JSON", () => {
    expect(extractVersion(PKG_JSON, "json")).toBe("0.0.12")
    expect(extractVersion(TAURI_JSON, "json")).toBe("0.0.12")
  })
  it("reads the [package] version from TOML, not a dependency's", () => {
    expect(extractVersion(CARGO_TOML, "toml")).toBe("0.0.12")
  })
  it("reads the named crate's version from a Cargo.lock, not a neighbour's", () => {
    expect(extractVersion(CARGO_LOCK, "lock", "luna-studio-ui")).toBe("0.0.12")
    // anchoring proof: ask for a crate pinned at a different version
    expect(extractVersion(CARGO_LOCK, "lock", "anyhow")).toBe("1.0.86")
  })
  it("returns null when the named crate is absent from the lock", () => {
    expect(extractVersion(CARGO_LOCK, "lock", "does-not-exist")).toBeNull()
  })
  it("throws when a lock extract is asked for without a package name", () => {
    expect(() => extractVersion(CARGO_LOCK, "lock")).toThrow()
  })
  it("returns null when absent", () => {
    expect(extractVersion(`{"name":"x"}`, "json")).toBeNull()
  })
})

describe("replaceVersion", () => {
  it("bumps JSON in place and is re-readable", () => {
    const out = replaceVersion(PKG_JSON, "json", "0.1.0")
    expect(extractVersion(out, "json")).toBe("0.1.0")
    expect(out).toContain(`"name": "ui-studio-tauri"`) // other fields untouched
  })
  it("bumps ONLY the package version in TOML, leaving the dependency's 2.0.0", () => {
    const out = replaceVersion(CARGO_TOML, "toml", "0.1.0")
    expect(extractVersion(out, "toml")).toBe("0.1.0")
    expect(out).toContain(`tauri = { version = "2.0.0" }`) // dependency untouched
  })
  it("bumps ONLY luna-studio-ui in the lock, leaving neighbour crate versions put", () => {
    const out = replaceVersion(CARGO_LOCK, "lock", "0.1.0", "luna-studio-ui")
    expect(extractVersion(out, "lock", "luna-studio-ui")).toBe("0.1.0")
    expect(extractVersion(out, "lock", "anyhow")).toBe("1.0.86") // decoy above untouched
    expect(extractVersion(out, "lock", "tauri")).toBe("2.0.0") // decoy below untouched
  })
  it("throws when the named crate is not in the lock", () => {
    expect(() => replaceVersion(CARGO_LOCK, "lock", "0.1.0", "nope")).toThrow()
  })
  it("throws when there is no version field to replace", () => {
    expect(() => replaceVersion(`name = "x"\n`, "toml", "1.2.3")).toThrow()
  })
})

describe("checkSync", () => {
  const m = (a: string, b: string, c: string, d: string) =>
    new Map([
      [VERSION_FILES[0].path, a],
      [VERSION_FILES[1].path, b],
      [VERSION_FILES[2].path, c],
      [VERSION_FILES[3].path, d],
    ])

  it("ok when all four agree on a valid semver", () => {
    const res = checkSync(m(PKG_JSON, CARGO_TOML, TAURI_JSON, CARGO_LOCK))
    expect(res.ok).toBe(true)
    expect(res.distinct).toEqual(["0.0.12"])
  })
  it("FAILS on drift (the footgun this gate exists to catch)", () => {
    const drifted = CARGO_TOML.replace("0.0.12", "0.0.13")
    const res = checkSync(m(PKG_JSON, drifted, TAURI_JSON, CARGO_LOCK))
    expect(res.ok).toBe(false)
    expect([...res.distinct].sort()).toEqual(["0.0.12", "0.0.13"])
  })
  it("FAILS when the Cargo.lock entry drifts from the rest (the gap this closes)", () => {
    const staleLock = CARGO_LOCK // stays 0.0.12 while the rest move to 0.0.13
    const bump = (s: string) => s.replace("0.0.12", "0.0.13")
    const res = checkSync(m(bump(PKG_JSON), bump(CARGO_TOML), bump(TAURI_JSON), staleLock))
    expect(res.ok).toBe(false)
    expect([...res.distinct].sort()).toEqual(["0.0.12", "0.0.13"])
  })
  it("FAILS when a file is missing its version", () => {
    const res = checkSync(m(PKG_JSON, CARGO_TOML, `{"name":"x"}`, CARGO_LOCK))
    expect(res.ok).toBe(false)
  })
})
