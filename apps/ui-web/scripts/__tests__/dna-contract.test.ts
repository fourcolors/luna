import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const repoRoot = resolve(__dirname, "../../../..")
const dna = () => readFileSync(resolve(repoRoot, "DNA.md"), "utf8")

describe("Luna DNA contract", () => {
  it("describes Luna as the operator's helpful assistant and protective partner without personal names", () => {
    const content = dna()

    expect(content).not.toContain("Sterling")
    expect(content).toContain("helpful assistant")
    expect(content).toContain("Protect Operator")
    expect(content).toContain("Ask before taking irreversible or externally visible actions")
  })
})
