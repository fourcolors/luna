// qrcode-terminal ships no types; it is CJS `module.exports = { generate, setErrorLevel, error }`.
declare module "qrcode-terminal" {
  interface QRCodeTerminal {
    generate(input: string, opts?: { small?: boolean }): void
    setErrorLevel(level: "L" | "M" | "Q" | "H"): void
    error: string | null
  }
  const qrcode: QRCodeTerminal
  export = qrcode
}
