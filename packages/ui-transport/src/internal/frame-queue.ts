import type { ChatFrame } from "../contract.js"

/**
 * FrameQueue — a per-session async queue feeding `ChatSession.messages`.
 *
 * Single-consumer FIFO with parked-consumer semantics:
 * - push(): resolves a parked next() waiter immediately (waiter-shift), or
 *   buffers the frame when no consumer is waiting. A no-op once closed.
 * - drainClose(): flips closed and resolves every parked waiter with
 *   done:true (splice-drain); buffered frames remain readable.
 * - messages: an AsyncIterable<ChatFrame> whose next() drains the buffer
 *   first, parks a waiter when empty-and-open, and returns done:true once
 *   closed-and-drained. return() drainClose()s the queue.
 *
 * Shared by LunaWsAdapter and HermesHttpSseAdapter.
 */
export interface FrameQueue {
  readonly push: (frame: ChatFrame) => void
  readonly drainClose: () => void
  readonly isClosed: () => boolean
  readonly messages: AsyncIterable<ChatFrame>
}

export function createFrameQueue(): FrameQueue {
  const frameQueue: Array<ChatFrame> = []
  const frameWaiters: Array<(v: IteratorResult<ChatFrame>) => void> = []
  let closed = false

  function push(frame: ChatFrame): void {
    if (closed) return
    const waiter = frameWaiters.shift()
    if (waiter) {
      waiter({ value: frame, done: false })
    } else {
      frameQueue.push(frame)
    }
  }

  function drainClose(): void {
    closed = true
    for (const w of frameWaiters.splice(0)) {
      w({ value: undefined as unknown as ChatFrame, done: true })
    }
  }

  const messages: AsyncIterable<ChatFrame> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<ChatFrame>> {
          if (closed && frameQueue.length === 0) {
            return Promise.resolve({ value: undefined as unknown as ChatFrame, done: true })
          }
          const queued = frameQueue.shift()
          if (queued !== undefined) {
            return Promise.resolve({ value: queued, done: false })
          }
          if (closed) {
            return Promise.resolve({ value: undefined as unknown as ChatFrame, done: true })
          }
          return new Promise<IteratorResult<ChatFrame>>((resolve) => {
            frameWaiters.push(resolve)
          })
        },
        return(): Promise<IteratorResult<ChatFrame>> {
          drainClose()
          return Promise.resolve({ value: undefined as unknown as ChatFrame, done: true })
        },
      }
    },
  }

  return { push, drainClose, isClosed: () => closed, messages }
}
