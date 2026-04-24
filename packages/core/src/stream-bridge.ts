/**
 * Stream ↔ AsyncIterable bridge — the load-bearing primitive per DESIGN.md §12.
 *
 * Effect already provides `Stream.fromAsyncIterable` and `Stream.toAsyncIterable`;
 * this module is a thin, documentation-heavy wrapper so every caller goes
 * through a single well-named entry point and the invariants (§12.2) are
 * pinned in one place.
 *
 * Invariants:
 *   #1 Iterable lifetime ≡ Scope lifetime. Closing the Stream calls the
 *      iterator's `return()` (Effect's impl); closing the outer Scope of
 *      `toAsyncIterable` interrupts the runner fiber.
 *   #2 Errors propagate. The `onError` function MUST map every thrown value
 *      to a typed error — never swallow.
 */
import { Effect, Stream } from "effect"

/**
 * Convert an `AsyncIterable<A>` into a `Stream<A, E>`.
 */
export const fromAsyncIterable = <A, E>(
  source: () => AsyncIterable<A>,
  onError: (u: unknown) => E,
): Stream.Stream<A, E> => Stream.fromAsyncIterable(source(), onError)

/**
 * Convert a `Stream<A, E>` into an `AsyncIterable<A>`, bound to a Scope.
 * When the Scope closes, consumers of the iterable will see the stream end
 * (either normally or via an interruption-induced `return()`).
 */
export const toAsyncIterable = <A, E>(
  stream: Stream.Stream<A, E>,
): AsyncIterable<A> => Stream.toAsyncIterable(stream)

/**
 * Effectful variant — returns an `Effect` that yields the iterable, carrying
 * the Stream's requirements `R` through the type. Use this when you need
 * Scope-carried resources (the typical session path).
 */
export const toAsyncIterableEffect = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
): Effect.Effect<AsyncIterable<A>, never, R> =>
  Stream.toAsyncIterableEffect(stream)
