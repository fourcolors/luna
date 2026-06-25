import { createReferenceProvider, type ReferenceProvider } from "../src/index.js"
import {
  describeProviderConformance,
  type ConformanceHarness,
  type SeedCapability,
} from "../src/testing/index.js"

const toRaw = (seed: readonly SeedCapability[], generation: number): unknown => ({
  generation,
  agreedSchema: 1,
  capabilities: seed.map((s) => ({
    kind: s.kind,
    id: s.id,
    title: s.title ?? s.id,
    executor: s.executor ?? "server",
    schemaVersion: 1,
  })),
})

// The reference provider proves the suite and the reference agree (suite ⇄ reference).
const harness: ConformanceHarness = {
  makeProvider: (seed) => createReferenceProvider({ initial: toRaw(seed, 1) }),
  executionsOf: (p) => (p as ReferenceProvider).executions,
  refresh: (p, seed) => (p as ReferenceProvider).setRawCatalog(toRaw(seed, 2)),
  makeUnavailable: () => {
    const p = createReferenceProvider()
    p.setUnavailable("backend down")
    return p
  },
}

describeProviderConformance("reference-provider", harness)
