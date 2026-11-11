// The host's ACP client remains the permission authority. Pi's native tools and untrusted
// extensions must already be disabled by the app-owned adapter before this guard is installed.
export const GUARD_NAME = 'open-science-pi-permission-guard'
const BLOCKED = Object.freeze({
  block: true,
  reason: 'Open Science did not authorize this tool call.'
})
function deny(reason) {
  process.stderr.write(`[open-science-pi] permission denied: ${reason}\n`)
  return BLOCKED
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry)
  } else {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) throw new Error('Unsupported tool input')
    for (const entry of Object.values(value)) deepFreeze(entry)
  }
  return Object.freeze(value)
}

// Pi can hash truncated or colliding MCP names. The host broker cannot safely reconstruct those
// identities from the model-facing name, so admit only exact, reversible server/tool projections.
function identifiesConfiguredMcpTool(name, definition, servers) {
  if (!definition || typeof definition.label !== 'string') return false
  const matches = servers.filter((server) => definition.label.startsWith(`${server}/`))
  if (matches.length !== 1) return false
  const server = matches[0]
  const tool = definition.label.slice(server.length + 1)
  if (!/^[A-Za-z0-9_]+$/.test(tool)) return false
  const expected = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, '_')
  return expected.length <= 64 && expected === name
}

export function createPermissionGuard({ conn, sessionId, flush, getDefinition, serverNames }) {
  const servers = [...new Set(serverNames)]
  return {
    name: GUARD_NAME,
    hidden: true,
    factory(pi) {
      pi.on('tool_call', async (event, context) => {
        // In the pinned Pi version, discovery only lists and activates tools; it cannot execute
        // them. Aggregate resource tools lack a server-qualified identity and remain blocked.
        if (event.toolName === 'tool_search' && event.parentToolCallId === undefined) return
        if (
          event.parentToolCallId !== undefined ||
          typeof event.toolCallId !== 'string' ||
          !event.toolCallId ||
          !context.signal ||
          context.signal.aborted ||
          !sessionId
        )
          return deny('invalid-call-context')

        const definition = getDefinition(event.toolName)
        if (!identifiesConfiguredMcpTool(event.toolName, definition, servers))
          return deny('unrecognized-tool')
        let before
        let rawInput
        try {
          before = JSON.stringify(event.input)
          if (!before) return deny('invalid-input')
          rawInput = JSON.parse(before)
          deepFreeze(event.input)
          Object.freeze(event)
        } catch {
          return deny('invalid-input')
        }

        const signal = context.signal
        let abort
        const cancelled = new Promise((resolve) => {
          abort = () => resolve(undefined)
          signal.addEventListener('abort', abort, { once: true })
        })
        try {
          const flushed = await Promise.race([
            Promise.resolve()
              .then(flush)
              .then(
                () => true,
                () => false
              ),
            cancelled
          ])
          if (flushed !== true || signal.aborted) return deny('flush-failed-or-cancelled')
          const request = conn
            .requestPermission({
              sessionId,
              toolCall: {
                toolCallId: event.toolCallId,
                name: event.toolName,
                title: event.toolName,
                kind: 'other',
                status: 'pending',
                rawInput
              },
              options: [
                { kind: 'allow_once', optionId: 'allow_once', name: 'Allow once' },
                { kind: 'reject_once', optionId: 'reject_once', name: 'Reject once' }
              ]
            })
            .catch(() => undefined)
          const answer = await Promise.race([request, cancelled])
          if (
            signal.aborted ||
            answer?.outcome?.outcome !== 'selected' ||
            answer.outcome.optionId !== 'allow_once' ||
            JSON.stringify(event.input) !== before ||
            getDefinition(event.toolName) !== definition
          )
            return deny('permission-rejected-or-stale')
          return
        } catch {
          return deny('permission-error')
        } finally {
          signal.removeEventListener('abort', abort)
        }
      })
    }
  }
}
