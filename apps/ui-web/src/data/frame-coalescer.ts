export interface FrameCoalescer<T> {
  push(value: T): void
  flush(): void
  cancel(): void
}

type ScheduleFrame = (callback: () => void) => number
type CancelFrame = (handle: number) => void

/**
 * Keeps only the newest input until the next paint. Pointer devices can emit
 * faster than the display refresh rate; callers get one state transition per
 * frame and can flush the pending value before ending an interaction.
 */
export function createFrameCoalescer<T>(
  apply: (value: T) => void,
  schedule: ScheduleFrame = (callback) => window.requestAnimationFrame(callback),
  cancelFrame: CancelFrame = (handle) => window.cancelAnimationFrame(handle),
): FrameCoalescer<T> {
  let frame: number | null = null
  let latest: T
  let hasLatest = false

  const applyLatest = (): void => {
    frame = null
    if (!hasLatest) return
    const value = latest
    hasLatest = false
    apply(value)
  }

  return {
    push(value) {
      latest = value
      hasLatest = true
      if (frame === null) frame = schedule(applyLatest)
    },
    flush() {
      if (frame !== null) {
        cancelFrame(frame)
        frame = null
      }
      applyLatest()
    },
    cancel() {
      if (frame !== null) cancelFrame(frame)
      frame = null
      hasLatest = false
    },
  }
}
