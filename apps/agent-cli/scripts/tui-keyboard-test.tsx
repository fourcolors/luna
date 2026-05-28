// Isolated keyboard smoke for OpenTUI on this machine.
//
// Run from repo root:
//   bun --preload @opentui/solid/preload apps/agent-cli/scripts/tui-keyboard-test.tsx
//
// What you should see:
//   - A box appears showing "typed: " on the first line
//   - "keys seen: 0" on the second line
//   - Press any letter — the first line updates to show what you typed
//     and the count increments
//   - Press 'q' to quit cleanly
//
// If you press keys and the count stays at 0, OpenTUI's stdin reader is
// not getting bytes on your terminal — that's the bug we need to fix.
import { createSignal, createComponent } from "solid-js"
import { render, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"

const App = () => {
  const dims = useTerminalDimensions()
  const renderer = useRenderer()
  const [typed, setTyped] = createSignal("")
  const [count, setCount] = createSignal(0)
  const [lastEvent, setLastEvent] = createSignal("(none yet)")

  useKeyboard((evt) => {
    setCount((n) => n + 1)
    setLastEvent(
      `name=${evt.name ?? "?"} ctrl=${evt.ctrl ?? false} seq=${JSON.stringify(evt.sequence ?? "")}`,
    )
    if (evt.name === "q") {
      renderer?.destroy()
      return
    }
    if (evt.sequence !== undefined && evt.sequence.length === 1 && evt.sequence.charCodeAt(0) >= 0x20) {
      setTyped((t) => t + evt.sequence)
    }
  })

  return (
    <box style={{ flexDirection: "column", width: dims().width, height: dims().height, padding: 1 }}>
      <text>{"typed: " + typed()}</text>
      <text>{"keys seen: " + count()}</text>
      <text>{"last event: " + lastEvent()}</text>
      <text>{"terminal: " + dims().width + "x" + dims().height}</text>
      <text>{"---"}</text>
      <text>{"press q to quit"}</text>
    </box>
  )
}

let resolveDone!: () => void
const done = new Promise<void>((resolve) => { resolveDone = resolve })

await render(() => createComponent(App, {}), {
  useThread: false,
  onDestroy: () => resolveDone(),
})

await done
process.exit(0)
