/**
 * TelemetryService — public types (Phase 18).
 *
 * Minimal in-process metrics service. Provides Counter primitives only
 * (Gauge/Histogram deferred per advisor verdict — YAGNI until a real
 * caller demands them).
 *
 * Snapshots are pull-based: callers (tests, UI, health endpoints,
 * external exporters) read the current map via `snapshot()`. There is
 * NO automatic emission into ObservabilityService — DESIGN §16's event
 * schema is unchanged.
 *
 * For external persistence (DuckDB, Prometheus, OTLP), an exporter
 * adapter polls `snapshot()` on its own cadence — separate from
 * framework code.
 */
import type { Effect } from "effect"

/** Tag map: small dimension set per metric. Keys are lowercase, values are strings. */
export type MetricTags = Readonly<Record<string, string>>

/** A single counter value with its tags. */
export interface CounterSnapshot {
  readonly name: string
  readonly tags: MetricTags
  readonly value: number
  /** ISO timestamp of the most recent inc() call. */
  readonly lastUpdatedTs: string
}

export interface TelemetryConfig {
  /** Reserved for future config (default level filters, etc.). */
  readonly _reserved?: never
}

export interface TelemetryApi {
  /**
   * Increment a counter by `n` (default 1). Tags partition the counter:
   * `inc("toolCalls", { tool: "bash" })` and `inc("toolCalls", { tool: "edit" })`
   * track separate counters under the same name.
   */
  readonly inc: (
    name: string,
    tags?: MetricTags,
    n?: number,
  ) => Effect.Effect<void>

  /**
   * Get the current value of a specific counter (name + tags). Returns
   * 0 if the counter has not been incremented.
   */
  readonly get: (name: string, tags?: MetricTags) => Effect.Effect<number>

  /**
   * Return a snapshot of every counter currently tracked.
   */
  readonly snapshot: Effect.Effect<CounterSnapshot[]>

  /**
   * Clear all counters. Useful for tests.
   */
  readonly reset: Effect.Effect<void>
}
