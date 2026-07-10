// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { UIState } from "@luna/ui-shared/core"
import { useStudioThreads } from "./useStudioThreads"
import { createUiStore, shallowEqual, useUiSelector } from "./useUiStore"

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const selectSettings = (state: UIState) => ({
  accounts: state.accounts,
  availableModels: state.availableModels,
})
const selectLastPing = (state: UIState): string | null => state.lastPingAt

const mounted: Array<{ root: ReturnType<typeof createRoot>; container: HTMLDivElement }> = []

function mount(element: React.ReactNode): void {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(element))
  mounted.push({ root, container })
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
})

describe("selector-capable UI store", () => {
  it("does not notify listeners when the reducer returns the same state", () => {
    const store = createUiStore()
    const listener = vi.fn()
    store.subscribe(listener)

    store.dispatch({
      type: "assistant-delta",
      threadId: "unknown",
      turnId: "turn-1",
      text: "ignored",
    })

    expect(listener).not.toHaveBeenCalled()
  })

  it("rerenders only consumers whose selected snapshot changed", () => {
    const store = createUiStore()
    const settingsRender = vi.fn()
    const pingRender = vi.fn()

    function SettingsConsumer() {
      useUiSelector(store, selectSettings, shallowEqual)
      settingsRender()
      return null
    }
    function PingConsumer() {
      useUiSelector(store, selectLastPing)
      pingRender()
      return null
    }

    mount(React.createElement(
      React.Fragment,
      null,
      React.createElement(SettingsConsumer),
      React.createElement(PingConsumer),
    ))
    expect(settingsRender).toHaveBeenCalledTimes(1)
    expect(pingRender).toHaveBeenCalledTimes(1)

    act(() => store.dispatch({ type: "ping", ts: "2026-07-10T10:00:00Z" }))

    expect(settingsRender).toHaveBeenCalledTimes(1)
    expect(pingRender).toHaveBeenCalledTimes(2)

    act(() => store.dispatch({
      type: "account-list",
      accounts: [{ id: "primary", label: "Primary", kind: "claude-code", health: "ready" }],
    }))

    expect(settingsRender).toHaveBeenCalledTimes(2)
    expect(pingRender).toHaveBeenCalledTimes(2)
  })

  it("keeps system-thread streaming out of user thread consumers", () => {
    const store = createUiStore()
    const summary = (id: string, tags: string[]) => ({
      id,
      parentId: null,
      title: id,
      tags,
      createdAt: 1,
      endedAt: null,
      model: "default",
      status: "active" as const,
      lastMessageAt: null,
      lastMessagePreview: null,
    })
    store.dispatch({
      type: "thread-list",
      threads: [summary("user-thread", []), summary("inbox-thread", ["system"])],
    })
    store.dispatch({ type: "thread-snapshot", threadId: "user-thread", throughSeq: 0, messages: [] })
    store.dispatch({ type: "thread-snapshot", threadId: "inbox-thread", throughSeq: 0, messages: [] })

    const render = vi.fn()
    function ThreadConsumer() {
      useStudioThreads(store)
      render()
      return null
    }
    mount(React.createElement(ThreadConsumer))
    expect(render).toHaveBeenCalledTimes(1)

    act(() => store.dispatch({
      type: "assistant-delta",
      threadId: "inbox-thread",
      turnId: "inbox-turn",
      text: "background projection",
    }))
    expect(render).toHaveBeenCalledTimes(1)

    act(() => store.dispatch({
      type: "assistant-delta",
      threadId: "user-thread",
      turnId: "user-turn",
      text: "visible reply",
    }))
    expect(render).toHaveBeenCalledTimes(2)
  })
})
