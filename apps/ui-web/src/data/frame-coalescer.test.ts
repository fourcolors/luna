import { describe, expect, it, vi } from "vitest"
import { createFrameCoalescer } from "./frame-coalescer"

describe("frame coalescer", () => {
  it("applies only the newest value once per frame", () => {
    const callbacks = new Map<number, () => void>()
    const apply = vi.fn()
    let nextHandle = 1
    const coalescer = createFrameCoalescer(
      apply,
      (callback) => {
        const handle = nextHandle++
        callbacks.set(handle, callback)
        return handle
      },
      (handle) => callbacks.delete(handle),
    )

    coalescer.push({ x: 1, y: 2 })
    coalescer.push({ x: 7, y: 8 })

    expect(callbacks.size).toBe(1)
    callbacks.get(1)?.()
    expect(apply).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenLastCalledWith({ x: 7, y: 8 })
  })

  it("flushes pending work and cancellation drops it", () => {
    const callbacks = new Map<number, () => void>()
    const apply = vi.fn()
    let nextHandle = 1
    const coalescer = createFrameCoalescer(
      apply,
      (callback) => {
        const handle = nextHandle++
        callbacks.set(handle, callback)
        return handle
      },
      (handle) => callbacks.delete(handle),
    )

    coalescer.push("final position")
    coalescer.flush()
    expect(callbacks.size).toBe(0)
    expect(apply).toHaveBeenCalledWith("final position")

    coalescer.push("discard me")
    coalescer.cancel()
    expect(callbacks.size).toBe(0)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it("does not reserve undefined as an internal sentinel", () => {
    const apply = vi.fn()
    const callbacks: Array<() => void> = []
    const coalescer = createFrameCoalescer<undefined>(
      apply,
      (next) => {
        callbacks.push(next)
        return 1
      },
      () => undefined,
    )

    coalescer.push(undefined)
    callbacks[0]?.()
    expect(apply).toHaveBeenCalledWith(undefined)
  })
})
