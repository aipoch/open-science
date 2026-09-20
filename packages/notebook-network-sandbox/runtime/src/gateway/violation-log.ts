import { NETWORK_APPROVAL_REQUIRED, NETWORK_POLICY_BLOCKED } from './recovery-context.js'

const MAX_EVENTS_PER_COMMAND = 32

const clean = (value: string): string =>
  value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000)

const pathNear = (stderr: string, failure: string): string | undefined => {
  const path = String.raw`([A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]+|\/[^\s'"\x60:]+)`
  for (const line of stderr.split(/\r?\n/)) {
    const failureMatch = new RegExp(failure, 'i').exec(line)
    if (!failureMatch) continue
    const before = [...line.slice(0, failureMatch.index).matchAll(new RegExp(path, 'gi'))].at(
      -1
    )?.[1]
    const after = line
      .slice(failureMatch.index + failureMatch[0].length)
      .match(new RegExp(path, 'i'))?.[1]
    const candidate = before ?? after
    if (candidate) return clean(candidate)
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
    hiddenBySandbox: (path: string) => boolean = () => false
  ): string {
    const events = this.#events.get(commandId)
    this.#events.delete(commandId)
    const permissionDenied = new RegExp(permissionFailure, 'i').test(stderr)
    const missing = missingPath(stderr)
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
    const path = (permissionDenied ? deniedPath(stderr) : undefined) ?? hiddenMissingPath
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
