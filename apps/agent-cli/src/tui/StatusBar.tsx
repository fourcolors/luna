import type { TuiStore } from "./store.js"

export type StatusBarProps = { store: TuiStore }

export const StatusBar = (props: StatusBarProps) => {
  const line = () => {
    const id = props.store.threadId()
    const idStr = id === null ? "—" : id.slice(0, 8)
    return (
      props.store.profileName() +
      " · thread " +
      idStr +
      " · shell " +
      (props.store.localShellEnabled() ? "on" : "off") +
      " · " +
      props.store.connection()
    )
  }

  return (
    <box style={{ flexShrink: 0 }}>
      <text>{line()}</text>
    </box>
  )
}
