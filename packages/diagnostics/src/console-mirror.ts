import { Console } from 'node:console'

const terminal = new Console({
  stdout: process.stdout,
  stderr: process.stderr,
  // Let the mirror catch synchronous write errors and permanently disable that output.
  ignoreErrors: false
})
const inspectorConsole = process.features.inspector
  ? process.getBuiltinModule('node:inspector')?.console
  : undefined

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error'
const monitored = new WeakSet<NodeJS.WriteStream>()
const failed = new WeakSet<NodeJS.WriteStream>()

// Console output is optional. Persistent listeners handle asynchronous stream errors; the catch
// below handles synchronous throws. Stop mirroring to a failed output while keeping the other
// output and the structured file sink independent.
const mirror = (method: ConsoleMethod, output: NodeJS.WriteStream, args: unknown[]): void => {
  // A separate Console is not wired to the debugger like global console is. Keep this channel
  // independent so a failed terminal does not hide already-redacted diagnostic events.
  try {
    inspectorConsole?.[method](...args)
  } catch {
    // Debugger delivery is optional, just like terminal mirroring.
  }
  if (failed.has(output)) return
  if (!monitored.has(output)) {
    output.on('error', () => failed.add(output))
    monitored.add(output)
  }
  try {
    terminal[method](...args)
  } catch {
    // TTY/file writes may throw synchronously instead of emitting a stream error.
    failed.add(output)
  }
}

// Handle only this optional sink. Do not install a process-wide exception/rejection handler.
export const consoleMirror = {
  log: (...args: unknown[]): void => mirror('log', process.stdout, args),
  info: (...args: unknown[]): void => mirror('info', process.stdout, args),
  warn: (...args: unknown[]): void => mirror('warn', process.stderr, args),
  error: (...args: unknown[]): void => mirror('error', process.stderr, args)
}
