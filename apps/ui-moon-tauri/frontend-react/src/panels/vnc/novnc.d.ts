/**
 * novnc.d.ts - ambient types for @novnc/novnc (the package ships no .d.ts).
 * Declared to exactly the members VncPanel uses; widen as needed.
 */
declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      urlOrChannel: string | WebSocket | RTCDataChannel,
      options?: {
        shared?: boolean
        credentials?: Record<string, string>
        repeaterID?: string
        wsProtocols?: string[]
      },
    )
    scaleViewport: boolean
    clipViewport: boolean
    resizeSession: boolean
    viewOnly: boolean
    focusOnClick: boolean
    dragViewport: boolean
    background: string
    disconnect(): void
    sendCredentials(creds: Record<string, string>): void
    sendCtrlAltDel(): void
    sendKey(keysym: number, code: string, down?: boolean): void
  }
}
