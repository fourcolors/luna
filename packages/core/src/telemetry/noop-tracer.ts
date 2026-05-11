/**
 * NoopTracerLayer — Phase 20.
 *
 * Provides a no-op Effect v3 Tracer Layer so that Effect.withSpan and
 * Effect.annotateCurrentSpan work in environments without a real tracing
 * backend. Spans are created structurally (all methods are no-ops) and
 * emit nothing.
 *
 * Use in tests and lightweight deployments where OpenTelemetry is not wired.
 */
import { Context, Layer, Option, Tracer } from "effect"

// ── No-op Span ────────────────────────────────────────────────────────────────

const noopSpan: Tracer.Span = {
  _tag: "Span",
  name: "noop",
  spanId: "0000000000000000",
  traceId: "00000000000000000000000000000000",
  parent: Option.none(),
  context: Context.empty(),
  status: { _tag: "Started", startTime: BigInt(0) },
  attributes: new Map(),
  links: [],
  sampled: false,
  kind: "internal",
  end: (_endTime, _exit) => { /* no-op */ },
  attribute: (_key, _value) => { /* no-op */ },
  event: (_name, _startTime, _attributes) => { /* no-op */ },
  addLinks: (_links) => { /* no-op */ },
}

// ── No-op Tracer ──────────────────────────────────────────────────────────────

const noopTracer: Tracer.Tracer = Tracer.make({
  span: (_name, _parent, _context, _links, _startTime, _kind) => noopSpan,
  context: (f, _fiber) => f(),
})

// ── Layer ─────────────────────────────────────────────────────────────────────

/**
 * A Layer that provides a no-op Tracer. Provide this wherever Effect.withSpan
 * or Effect.annotateCurrentSpan is used without a real OTel backend.
 *
 * Layer.Layer<never> — provides the Tracer service, requires nothing.
 */
export const NoopTracerLayer: Layer.Layer<never> = Layer.succeed(
  Tracer.Tracer,
  noopTracer,
)
