/**
 * Broadcast<T> — a last-value-wins multi-consumer async iterable.
 *
 * Each call to subscribe() returns an independent AsyncIterableIterator<T>.
 * - REPLAY-LATEST: if a current value exists when subscribe() is called,
 *   the first next() resolves immediately with that value.
 * - LAST-VALUE-WINS per subscriber: each subscriber holds at most 1 pending
 *   value (newer overwrites older); no unbounded buffering.
 * - close() terminates ALL active subscribers with done:true.
 * - Each subscriber's return() method removes only that subscriber.
 */
export class Broadcast<T> {
  /** The most recently published value, if any. */
  #last: { value: T } | null = null
  #closed = false
  #subscribers = new Set<Subscriber<T>>()

  subscribe(): AsyncIterableIterator<T> {
    const sub = new Subscriber<T>(this.#last, () => this.#subscribers.delete(sub))
    this.#subscribers.add(sub)
    return sub.iterator()
  }

  publish(v: T): void {
    if (this.#closed) return
    this.#last = { value: v }
    for (const sub of this.#subscribers) {
      sub.deliver(v)
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const sub of this.#subscribers) {
      sub.terminate()
    }
    this.#subscribers.clear()
  }
}

/**
 * A single subscriber slot. Holds at most one pending value (last-value-wins).
 * When a waiter is present, it is resolved immediately; otherwise the pending
 * value overwrites any previous unread value.
 */
class Subscriber<T> {
  #done = false
  /** A pending value not yet consumed by a waiter. */
  #pending: { value: T } | null
  /** Resolve callback waiting in next(). */
  #waiter: ((result: IteratorResult<T>) => void) | null = null
  readonly #onRemove: () => void

  constructor(initial: { value: T } | null, onRemove: () => void) {
    // Replay-latest: seed with the current value so first next() resolves fast.
    this.#pending = initial
    this.#onRemove = onRemove
  }

  deliver(v: T): void {
    if (this.#done) return
    if (this.#waiter) {
      // Waiter is blocked in next() — resolve it directly.
      const w = this.#waiter
      this.#waiter = null
      w({ value: v, done: false })
    } else {
      // Last-value-wins: overwrite any unread pending value.
      this.#pending = { value: v }
    }
  }

  terminate(): void {
    if (this.#done) return
    this.#done = true
    if (this.#waiter) {
      const w = this.#waiter
      this.#waiter = null
      w({ value: undefined as unknown as T, done: true })
    }
    this.#pending = null
  }

  iterator(): AsyncIterableIterator<T> {
    const self = this
    const iter: AsyncIterableIterator<T> = {
      next(): Promise<IteratorResult<T>> {
        if (self.#done) {
          return Promise.resolve({ value: undefined as unknown as T, done: true })
        }
        if (self.#pending !== null) {
          const val = self.#pending.value
          self.#pending = null
          return Promise.resolve({ value: val, done: false })
        }
        // Block until deliver() or terminate() is called.
        return new Promise<IteratorResult<T>>((resolve) => {
          self.#waiter = resolve
        })
      },
      return(): Promise<IteratorResult<T>> {
        self.#done = true
        // Resolve any pending waiter so the for-await loop can exit.
        if (self.#waiter) {
          const w = self.#waiter
          self.#waiter = null
          w({ value: undefined as unknown as T, done: true })
        }
        self.#pending = null
        self.#onRemove()
        return Promise.resolve({ value: undefined as unknown as T, done: true })
      },
      [Symbol.asyncIterator](): AsyncIterableIterator<T> {
        return iter
      },
    }
    return iter
  }
}
