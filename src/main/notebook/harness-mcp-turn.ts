import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  openAgentSession,
  type AgentCheckpoint,
  type AgentSession,
  type AgentSessionOptions,
  type AgentStore,
  type ContentBlock,
  type Json,
  type RunStatus
} from '@aipoch/agent-harness'
import { loadMcpTools } from '@aipoch/agent-harness/mcp'
import type { AcpPermissionBroker } from '../acp/permission-broker'
import type { NotebookLocalRpcServer } from './local-rpc-server'
import { createHarnessNotebookTools } from './harness-tools'
import {
  createNotebookMcpServer,
  notebookRpcToolsForEnvironment,
  type NotebookMcpEnvironment
} from './mcp-server'

const owners = new WeakMap<object, Set<string>>()

// A failed cell or non-zero shell exit is a known outcome: its result carries the Run identity or
// exit code. Transport and RPC errors carry neither, so their effects stay unknown.
const reportsRunOutcome = (content: unknown): boolean => {
  const first = Array.isArray(content) ? (content[0] as { type?: unknown; text?: unknown }) : null
  if (first?.type !== 'text' || typeof first.text !== 'string') return false
  try {
    const parsed = JSON.parse(first.text) as Record<string, unknown> | null
    return typeof parsed?.runId === 'string' || typeof parsed?.exitCode === 'number'
  } catch {
    return false
  }
}
type Authority = Pick<
  NotebookLocalRpcServer,
  'authorizeExecution' | 'clearArtifactTurnBinding' | 'getArtifactTurnScope'
>
type NotebookHarnessTurn = {
  run(prompt: ContentBlock[]): Promise<RunStatus>
  snapshot(): Promise<AgentCheckpoint>
  cancel(): void
  dispose(): Promise<void>
}

/** One explicitly bound host turn. Borrow the RPC capability; own only this MCP client/server. */
export async function openNotebookHarnessTurn(input: {
  environment: NotebookMcpEnvironment
  allowedNames: readonly string[]
  permissions: Pick<AcpPermissionBroker, 'requestAppApproval'>
  execution: { promptMessageId: string; ownerExecutionId: string; authority: Authority }
  /** The host binds provider/account invalidation to this signal and supplies its durable store. */
  session: Omit<AgentSessionOptions, 'tools' | 'signal'> & {
    signal: AbortSignal
    store: AgentStore
  }
}): Promise<NotebookHarnessTurn> {
  const { authority, promptMessageId, ownerExecutionId } = input.execution
  if (!ownerExecutionId.trim()) throw new Error('Missing Notebook turn owner')
  const bound = structuredClone({ ...input.environment, release: undefined })
  const scope = authority.getArtifactTurnScope(bound.sessionId)
  if (
    !scope ||
    scope.ownerExecutionId !== ownerExecutionId ||
    scope.promptMessageId !== promptMessageId ||
    scope.projectId !== bound.projectId
  )
    throw new Error('Notebook harness turn identity mismatch')
  bound.sessionId = scope.sessionId

  const occupied = owners.get(authority) ?? new Set<string>()
  if (occupied.has(bound.sessionId)) throw new Error('Notebook harness execution domain is busy')
  occupied.add(bound.sessionId)
  owners.set(authority, occupied)
  const lifetime = new AbortController()
  const signal = AbortSignal.any([input.session.signal, lifetime.signal])
  const client = new Client({ name: 'open-science-agent', version: '1' })
  let server: ReturnType<typeof createNotebookMcpServer> | undefined
  let session: AgentSession | undefined, closing: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    if (closing) return closing
    closing = (async () => {
      lifetime.abort()
      input.session.signal.removeEventListener('abort', onAbort)
      // RPC turn ownership outlives an aborted HTTP/MCP request; it confirms real execution drain.
      const drained = await Promise.allSettled([
        authority.clearArtifactTurnBinding(bound.sessionId, ownerExecutionId),
        session?.dispose(),
        client.close(),
        server?.close()
      ])
      const failures = drained.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      // Keep the domain fenced if remote termination could not be confirmed.
      if (failures.length) throw new AggregateError(failures, 'Notebook harness cleanup failed')
      occupied.delete(bound.sessionId)
    })()
    return closing
  }
  const onAbort = (): void => {
    void dispose().catch(() => undefined)
  }
  try {
    signal.throwIfAborted()
    const managed = createHarnessNotebookTools(bound, input.allowedNames, input.permissions, {
      promptMessageId,
      authority
    })
    const byName = new Map(managed.map((tool) => [tool.name, tool]))
    const definitions = notebookRpcToolsForEnvironment(bound)
    server = createNotebookMcpServer(bound)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const tools = await loadMcpTools({
      signal,
      client: {
        async listTools(cursor, requestSignal) {
          return client.listTools(cursor ? { cursor } : {}, { signal: requestSignal })
        },
        async callTool(name, args, context) {
          signal.throwIfAborted()
          context.signal.throwIfAborted()
          const current = authority.getArtifactTurnScope(bound.sessionId)
          if (
            !current ||
            current.sessionId !== bound.sessionId ||
            current.ownerExecutionId !== ownerExecutionId ||
            current.promptMessageId !== promptMessageId ||
            current.projectId !== scope.projectId
          )
            return {
              isError: true,
              content: [{ type: 'text', text: 'Notebook turn capability is no longer active.' }]
            }

          if (
            name !== 'list_authorized_directories' &&
            !authority.authorizeExecution({
              sessionId: bound.sessionId,
              promptMessageId,
              toolCallId: context.invocationId,
              method: name === 'notebook_execute' ? 'execute' : 'executeShell',
              rawInput: args
            })
          )
            return {
              isError: true,
              content: [{ type: 'text', text: 'Notebook execution admission is unavailable.' }]
            }
          try {
            const result = await client.callTool({ name, arguments: args }, undefined, {
              signal: context.signal,
              onprogress: (progress) => {
                if (progress.message) context.update([{ type: 'text', text: progress.message }])
              }
            })
            if (
              name !== 'list_authorized_directories' &&
              result.isError &&
              !reportsRunOutcome(result.content)
            )
              throw new Error('Notebook MCP execution outcome is unknown')
            return result
          } catch (error) {
            // The SDK cancellation notification is not proof that a kernel stopped.
            await authority.clearArtifactTurnBinding(bound.sessionId, ownerExecutionId)
            throw error
          }
        }
      },
      bind(definition) {
        const tool = byName.get(definition.name)
        if (!tool) return undefined
        const output = definitions.find((candidate) => candidate.name === tool.name)?.outputSchema
        return {
          parameters: tool.parameters as Json,
          description: tool.description,
          validate: (args) => tool.validate(args) as Json,
          authorize: (args, context) =>
            tool.authorize(args as Record<string, unknown>, context.signal),
          ...(output
            ? {
                validateOutput: (value: Json): void => {
                  output.parse(value)
                }
              }
            : {})
        }
      }
    })
    signal.throwIfAborted()
    session = await openAgentSession({ ...input.session, signal, tools })
    input.session.signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      await dispose()
      signal.throwIfAborted()
    }
    const opened = session
    let used = false
    return {
      async run(prompt) {
        if (used) throw new Error('Notebook harness turn has already run')
        used = true
        const [result] = await Promise.allSettled([opened.prompt(prompt)])
        try {
          await dispose()
        } catch (cleanupError) {
          if (result.status === 'rejected')
            throw new AggregateError(
              [result.reason, cleanupError],
              'Notebook harness execution and cleanup failed'
            )
          throw cleanupError
        }
        if (result.status === 'rejected') throw result.reason
        return result.value
      },
      snapshot: () => opened.snapshot(),
      cancel: () => {
        lifetime.abort()
        onAbort()
      },
      dispose
    }
  } catch (error) {
    try {
      await dispose()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Notebook harness startup failed')
    }
    throw error
  }
}
