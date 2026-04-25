/**
 * Frame reducer: pure function from (state, frame) → next state.
 *
 * Keeping this pure and separate from React makes it trivially testable
 * (one Vitest spec per case). All the "interesting" semantics — bounded
 * retention, drop-banner accumulation, kind discovery — live here.
 */
import type { ObsEvent, ObsEventKind, ServerFrame } from "./wire.js"

export interface UIState {
  readonly events: ReadonlyArray<ObsEvent>
  readonly seenKinds: ReadonlyArray<string>
  readonly advertisedKinds: ReadonlyArray<string>
  readonly droppedTotal: number
  readonly lastDrop: { readonly n: number; readonly since: string } | null
  readonly lastPingAt: string | null
  readonly closeReason: string | null
}

export const initialState: UIState = {
  events: [],
  seenKinds: [],
  advertisedKinds: [],
  droppedTotal: 0,
  lastDrop: null,
  lastPingAt: null,
  closeReason: null,
}

const MAX_RETAINED = 500

const addKindIfNew = (
  list: ReadonlyArray<string>,
  kind: string,
): ReadonlyArray<string> => (list.includes(kind) ? list : [...list, kind])

export const reduce = (state: UIState, frame: ServerFrame): UIState => {
  switch (frame.type) {
    case "hello":
      return {
        ...state,
        advertisedKinds: frame.kinds,
        // hello means a fresh connection — clear close-state.
        closeReason: null,
      }
    case "event": {
      const next = [frame.event, ...state.events].slice(0, MAX_RETAINED)
      return {
        ...state,
        events: next,
        seenKinds: addKindIfNew(state.seenKinds, frame.event.kind),
      }
    }
    case "drop":
      return {
        ...state,
        droppedTotal: state.droppedTotal + frame.n,
        lastDrop: { n: frame.n, since: frame.since },
      }
    case "ping":
      return { ...state, lastPingAt: frame.ts }
    case "bye":
      return { ...state, closeReason: frame.reason }
  }
}

export const filterEvents = (
  events: ReadonlyArray<ObsEvent>,
  selectedKinds: ReadonlySet<string>,
): ReadonlyArray<ObsEvent> => {
  if (selectedKinds.size === 0) return events
  return events.filter((e) => selectedKinds.has(e.kind))
}

export type { ObsEventKind }
