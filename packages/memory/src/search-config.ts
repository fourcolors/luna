/**
 * A compact, human-readable name for one memory-search variant, shared by
 * the benchmark harnesses (bench/memory-suite.ts, adapters/longmemeval-eval)
 * so a sweep is a list of strings and every result row is labelled with the
 * exact config that produced it.
 *
 *   <mode>[:w=<lexicalWeight>][:e=<expansionWeight>][:s=<stopwords>][:kw=<model>#<sample>]
 *
 *   hybrid
 *   hybrid-weighted:w=0.25:s=extended
 *   hybrid-weighted:w=0.25:s=extended:e=0.5:kw=haiku#0
 *
 * w / e / s only apply to hybrid-weighted. kw names an expansion-keyword
 * sidecar (bench/expansion/<source>-<model>.json, see bench/expand-queries.ts)
 * and which of its independent samples to use.
 */
import { MEMORY_SEARCH_MODES, type MemorySearchMode } from "@luna/core"
import type { LexicalFusionOptions, StopwordSet } from "./lexical-query.js"

export interface SearchConfig {
  readonly label: string
  readonly mode: MemorySearchMode
  readonly fusion?: Partial<LexicalFusionOptions>
  readonly expansion?: { readonly model: string; readonly sample: number }
}

const STOPWORD_SETS: ReadonlyArray<StopwordSet> = ["none", "lucene", "extended", "question"]

function weight(key: string, raw: string, label: string): number {
  const n = Number(raw)
  if (raw.trim() === "" || !Number.isFinite(n) || n < 0) {
    throw new Error(`search config "${label}": ${key}=${raw} must be a number >= 0`)
  }
  return n
}

/** Parse one config string; throws with the offending label on any error. */
export function parseSearchConfig(label: string): SearchConfig {
  const [modeRaw, ...parts] = label.trim().split(":")
  const mode = modeRaw as MemorySearchMode
  if (!(MEMORY_SEARCH_MODES as ReadonlyArray<string>).includes(mode)) {
    throw new Error(`search config "${label}": unknown mode "${modeRaw}" (${MEMORY_SEARCH_MODES.join(", ")})`)
  }
  const fusion: { lexicalWeight?: number; expansionWeight?: number; stopwords?: StopwordSet } = {}
  let expansion: SearchConfig["expansion"]
  for (const part of parts) {
    const eq = part.indexOf("=")
    const key = eq < 0 ? part : part.slice(0, eq)
    const value = eq < 0 ? "" : part.slice(eq + 1)
    if (key === "kw") {
      const m = /^([A-Za-z0-9._-]+)#(\d+)$/.exec(value)
      if (!m) throw new Error(`search config "${label}": kw must look like <model>#<sample>`)
      expansion = { model: m[1]!, sample: Number(m[2]) }
      continue
    }
    if (mode !== "hybrid-weighted") {
      throw new Error(`search config "${label}": ${key}= only applies to hybrid-weighted`)
    }
    if (key === "w") fusion.lexicalWeight = weight(key, value, label)
    else if (key === "e") fusion.expansionWeight = weight(key, value, label)
    else if (key === "s") {
      if (!(STOPWORD_SETS as ReadonlyArray<string>).includes(value)) {
        throw new Error(`search config "${label}": s must be one of ${STOPWORD_SETS.join(", ")}`)
      }
      fusion.stopwords = value as StopwordSet
    } else throw new Error(`search config "${label}": unknown key "${key}"`)
  }
  if (expansion !== undefined && mode !== "hybrid-weighted") {
    throw new Error(`search config "${label}": kw= only has an effect on hybrid-weighted`)
  }
  return {
    label: label.trim(),
    mode,
    ...(Object.keys(fusion).length > 0 ? { fusion } : {}),
    ...(expansion !== undefined ? { expansion } : {}),
  }
}

/** Parse a comma-separated list; labels must be unique. */
export function parseSearchConfigs(list: string): ReadonlyArray<SearchConfig> {
  const configs = list
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(parseSearchConfig)
  const labels = new Set<string>()
  for (const c of configs) {
    if (labels.has(c.label)) throw new Error(`search config "${c.label}" listed twice`)
    labels.add(c.label)
  }
  if (configs.length === 0) throw new Error("no search configs given")
  return configs
}

/** Expansion-keyword sidecar written by bench/expand-queries.ts. */
export interface ExpansionSidecar {
  readonly source: string
  readonly model: string
  readonly promptHash: string
  readonly samples: number
  readonly keywords: Readonly<Record<string, ReadonlyArray<ReadonlyArray<string>>>>
}

/**
 * Keywords for one query under one config, or undefined when the config
 * uses none. A config that names keywords the sidecar lacks is an error,
 * never a silent "no keywords" run.
 */
export function expansionFor(
  config: SearchConfig,
  queryId: string,
  sidecars: ReadonlyMap<string, ExpansionSidecar>,
): ReadonlyArray<string> | undefined {
  if (config.expansion === undefined) return undefined
  const { model, sample } = config.expansion
  const sidecar = sidecars.get(model)
  if (sidecar === undefined) throw new Error(`config "${config.label}": no expansion sidecar loaded for model "${model}"`)
  const kws = sidecar.keywords[queryId]?.[sample]
  if (kws === undefined) {
    throw new Error(`config "${config.label}": sidecar "${model}" has no sample ${sample} for query ${queryId}`)
  }
  return kws
}
