/**
 * TelemetryPlatform — Phase 20.
 *
 * Pure composition Layer — no logic of its own.
 *
 * Composes the three telemetry sinks into a single Layer:
 *   - EventSink      — persists every ObsEvent to the `events` DuckDB table
 *   - SessionSync    — keeps the `sessions` table in sync with session lifecycle
 *   - MetricsFlusher — periodically flushes counters to `metric_snapshots`
 *
 * Combined requirements (union of all three sinks' deps):
 *   ObservabilityService | DuckDbService | TelemetryService | Clock
 *
 * Provides:
 *   EventSink | SessionSync | MetricsFlusher
 */
import { Layer } from "effect"
import { EventSink } from "./event-sink.js"
import { MetricsFlusher } from "./metrics-flusher.js"
import { SessionSync } from "./session-sync.js"

export const TelemetryPlatform = Layer.mergeAll(
  EventSink.makeLayer(),
  SessionSync.makeLayer(),
  MetricsFlusher.makeLayer(),
)
