/**
 * NoopTracerLayer — Phase 20.
 *
 * Provides a no-op Effect Tracer Layer so that Effect.withSpan and
 * Effect.annotateCurrentSpan work in environments without a real tracing
 * backend. Spans are created structurally and emit nothing.
 *
 * Use in tests and lightweight deployments where OpenTelemetry is not wired.
 */
import { Layer, Tracer } from "effect"

const noopTracer: Tracer.Tracer = Tracer.make({
  span(options) {
    return new Tracer.NativeSpan(options)
  },
})

/**
 * A Layer that provides a no-op Tracer. Provide this wherever Effect.withSpan
 * or Effect.annotateCurrentSpan is used without a real OTel backend.
 */
export const NoopTracerLayer: Layer.Layer<never> = Layer.succeed(
  Tracer.Tracer,
  noopTracer,
)
