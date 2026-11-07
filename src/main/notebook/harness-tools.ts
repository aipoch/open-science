import { z } from 'zod'
import { ToolValidationError } from '@aipoch/agent-harness'
import type { AcpPermissionBroker } from '../acp/permission-broker'
import type { HarnessTool } from '../settings/harness-turn'
import type { NotebookLocalRpcServer } from './local-rpc-server'
import {
  buildNotebookToolContent,
  callNotebookRpc,
  notebookRpcToolsForEnvironment,
  resolveNotebookRpcFetch,
  type NotebookMcpEnvironment
} from './mcp-server'

const SUPPORTED = new Set(['list_authorized_directories', 'notebook_execute', 'bash_execute'])

/** Reuses managed schemas/RPC and explicit one-call approval, without exposing routing credentials. */
export function createHarnessNotebookTools(
  environment: NotebookMcpEnvironment,
  allowedNames: readonly string[],
  permissions: Pick<AcpPermissionBroker, 'requestAppApproval'>,
  execution?: {
    promptMessageId: string
    authority: Pick<NotebookLocalRpcServer, 'authorizeExecution'>
  }
): readonly HarnessTool[] {
  const bound = structuredClone({ ...environment, release: undefined })
  const definitions = notebookRpcToolsForEnvironment(bound)
  if (new Set(allowedNames).size !== allowedNames.length) throw new Error('Duplicate harness tool')
  return allowedNames.map((name) => {
    const definition = definitions.find((tool) => tool.name === name)
    if (!SUPPORTED.has(name) || !definition) throw new Error('Unsupported harness Notebook tool')
    if (name !== 'list_authorized_directories' && !execution?.promptMessageId.trim())
      throw new Error('Harness execution requires an active Notebook turn binding')
    const promptMessageId = execution?.promptMessageId
    const authority = execution?.authority
    const schema = z
      .object({
        ...definition.inputSchema,
        // Background jobs need their own cancellation/recovery owner before admission here.
        ...(name !== 'list_authorized_directories'
          ? { background: z.literal(false).optional() }
          : {})
      })
      .strict()
    return {
      name,
      description:
        name === 'list_authorized_directories'
          ? definition.description
          : `${definition.description}\nOnly foreground execution is available in this harness session.`,
      parameters: z.toJSONSchema(schema, { target: 'draft-7' }),
      validate: (input) => {
        const parsed = schema.safeParse(input)
        if (!parsed.success)
          throw new ToolValidationError(
            parsed.error.issues.map((issue) => ({
              path: '$' + issue.path.map((part) => `.${String(part)}`).join(''),
              expected:
                issue.code === 'invalid_type' ? issue.expected : `valid value (${issue.code})`
            }))
          )
        return parsed.data
      },
      authorize: (args, signal) =>
        permissions.requestAppApproval({
          sessionId: bound.sessionId,
          title: definition.title,
          rawInput: { tool: name, arguments: args },
          signal
        }),
      execute: async (args, signal, callId) => {
        const method = definition.resolveMethod?.(args) ?? definition.method
        if (
          name !== 'list_authorized_directories' &&
          !authority!.authorizeExecution({
            sessionId: bound.sessionId,
            toolCallId: callId,
            promptMessageId: promptMessageId!,
            method: name === 'notebook_execute' ? 'execute' : 'executeShell',
            rawInput: args
          })
        )
          throw new Error('Harness Notebook execution admission is unavailable')
        const raw = await callNotebookRpc(
          bound,
          method,
          args,
          resolveNotebookRpcFetch(method),
          signal
        )
        const content = buildNotebookToolContent(raw, definition, args)
        if (content.some((block) => block.type !== 'text'))
          throw new Error('Harness requires text tool results')
        return JSON.stringify({ content })
      }
    }
  })
}
