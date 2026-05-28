import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"

export type ReadlineIo = {
  stdin: Readable
  stdout: Writable
  stderr: Writable
}

export const writeOut = (io: ReadlineIo, text: string): void => {
  io.stdout.write(text)
}

export const writeErr = (io: ReadlineIo, text: string): void => {
  io.stderr.write(text)
}

export const writeError = (io: ReadlineIo, message: string): void => {
  io.stderr.write(`error: ${message}\n`)
}

export const createLineReader = (io: ReadlineIo): ReturnType<typeof createInterface> =>
  createInterface({
    input: io.stdin,
    crlfDelay: Infinity,
    terminal: false,
  })
