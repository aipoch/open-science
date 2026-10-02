import { NETWORK_APPROVAL_REQUIRED, NETWORK_POLICY_BLOCKED } from './recovery-context.js'

const MAX_EVENTS_PER_COMMAND = 32

const clean = (value: string): string =>
  value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000)

const diagnosticLines = function* (output: string, failure: RegExp): Generator<string> {
  for (const line of output.split(/\r?\n/)) {
    // Unicode escapes can also encode the error phrase itself in a JSON message.
    if (!failure.test(line) && !line.includes('\\u')) continue
    // CLI JSON envelopes escape Windows separators. Decode complete JSON strings only;
    // replacing backslashes in ordinary output would corrupt UNC paths and escape sequences.
    // Advance monotonically: an unterminated string must not retry at every escaped quote.
    let index = 0
    while (index < line.length) {
      if (line[index] !== '"') {
        index += 1
        continue
      }
      const start = index++
      while (index < line.length && line[index] !== '"') {
        index += line[index] === '\\' ? 2 : 1
      }
      if (index >= line.length) break
      const literal = line.slice(start, ++index)
      try {
        yield JSON.parse(literal) as string
      } catch {
        // Quoted prose is not necessarily JSON; retain the original line below.
      }
    }
    yield line
  }
}

const pathNear = (output: string, failure: string): string | undefined => {
  const path = String.raw`([A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]+|\/[^\s'"\x60:]+)`
  const failurePattern = new RegExp(failure, 'i')
  for (const line of diagnosticLines(output, failurePattern)) {
    const failureMatch = failurePattern.exec(line)
    if (!failureMatch) continue
    const before = [...line.slice(0, failureMatch.index).matchAll(new RegExp(path, 'gi'))].at(
      -1
    )?.[1]
    const after = line
      .slice(failureMatch.index + failureMatch[0].length)
      .match(new RegExp(path, 'i'))?.[1]
    const candidate = before ?? after
    if (candidate) return clean(candidate).replace(/['"`]$/, '')
  }
  return undefined
}

const permissionFailure = String.raw`(?:permission denied|operation not permitted|access is denied|read-only file system)`
const deniedPath = (stderr: string): string | undefined => pathNear(stderr, permissionFailure)
const missingPath = (stderr: string): string | undefined =>
  pathNear(stderr, String.raw`no such file or directory`)

class ViolationLog {
  readonly #events = new Map<string, string[]>()

  record(commandId: string, description: string): void {
    const events = this.#events.get(commandId) ?? []
    if (events.length < MAX_EVENTS_PER_COMMAND) events.push(clean(description))
    this.#events.set(commandId, events)
  }

  attach(
    commandId: string,
    stderr: string,
    hiddenBySandbox: (path: string) => boolean = () => false,
    stdout = ''
  ): string {
    const events = this.#events.get(commandId)
    this.#events.delete(commandId)
    const diagnostics = `${stderr}\n${stdout}`
    const permissionDenied = new RegExp(permissionFailure, 'i').test(diagnostics)
    const missing = missingPath(diagnostics)
    const hiddenMissingPath = missing && hiddenBySandbox(missing) ? missing : undefined
    const lines = [...(events ?? [])]
    if (
      lines.some(
        (line) => line.startsWith('deny network-outbound ') && line.endsWith('(not approved)')
      )
    ) {
      lines.unshift(NETWORK_APPROVAL_REQUIRED)
    }
    if (
      lines.some(
        (line) => line.startsWith('deny network-outbound ') && !line.endsWith('(not approved)')
      )
    ) {
      lines.unshift(NETWORK_POLICY_BLOCKED)
    }
    const path = (permissionDenied ? deniedPath(diagnostics) : undefined) ?? hiddenMissingPath
    if (path) {
      lines.push(
        `OPEN_SCIENCE_FILESYSTEM_ACCESS_BLOCKED${path ? `: ${path}` : ''} ` +
          'Filesystem access failed; native permissions, read-only mounts, or the sandbox may be responsible. ' +
          'Check the path and required read/write access. Use a writable project path for output. ' +
          'If access outside the project is needed, ask the user to grant that specific folder and access mode in the Files view; retry only after access changes. ' +
          'request_network_access cannot grant filesystem access. Do not use sudo or disable the sandbox.'
      )
    }
    if (lines.length === 0) return stderr
    const separator = stderr && !stderr.endsWith('\n') ? '\n' : ''
    return `${stderr}${separator}<sandbox_violations>\n${lines.join('\n')}\n</sandbox_violations>\n`
  }

  forget(commandId: string): void {
    this.#events.delete(commandId)
  }

  clear(): void {
    this.#events.clear()
  }
}

export { ViolationLog }
