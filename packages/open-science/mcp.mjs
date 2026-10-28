/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { connectToOpenScience, OpenScienceApiError } from './index.mjs'

const id = (description) => z.string().trim().min(1).describe(description)
const sessionId = id('Session ID returned by list_sessions or start_run.')
const projectId = id('Project ID returned by list_projects or create_project.')
const runId = id('Run ID returned by start_run.')
const expectedRevision = z
  .number()
  .int()
  .nonnegative()
  .describe(
    'Current revision returned by the corresponding read tool. Stale revisions are rejected.'
  )
const agentConfiguration = z.strictObject({
  providerId: id('Configured provider ID.').optional(),
  model: id('Model identifier; null follows the provider default.').nullable().optional(),
  reasoningEffort: z.enum(['default', 'low', 'medium', 'high', 'xhigh', 'max']).optional()
})
const sessionSettings = {
  agentConfiguration: agentConfiguration.optional(),
  permissionProfile: z
    .enum(['ask', 'auto', 'full'])
    .describe(
      'Existing authorization policy. Omit to retain configured defaults; full grants broad execution authority.'
    )
    .optional(),
  autoReviewEnabled: z.boolean().optional(),
  memoryEnabled: z.boolean().optional(),
  delegationPolicy: z.enum(['allow', 'deny']).optional()
}
const agentContext = z.string().trim().min(1).max(16000)
const read = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
}
const write = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true
}
const result = (value) => ({
  content: [{ type: 'text', text: JSON.stringify({ result: value ?? null }) }],
  structuredContent: { result: value ?? null }
})

// Do not forward raw exception messages: HTTP failures may contain credentials or response bodies.
const toolError = (error) => {
  const messages = {
    daemon_unavailable:
      'Open-Science is not running. Start it with "open-science start" for the selected profile, then retry.',
    unsupported_capability:
      'The service does not support this operation. Update the service before retrying.',
    project_not_found: 'Project not found. Refresh list_projects.',
    session_not_found: 'Session not found. Refresh list_sessions.',
    run_not_found: 'Run not found. Check the ID returned by start_run.',
    invalid_request: 'Invalid request. Check the tool arguments and service configuration.',
    request_timeout:
      'Request timed out. A write may already have succeeded; check its state before retrying.'
  }
  const code =
    error instanceof OpenScienceApiError && Object.hasOwn(messages, error.code)
      ? error.code
      : 'request_failed'
  const status = error instanceof OpenScienceApiError ? error.status : undefined
  const message =
    status === 401 || status === 403
      ? 'Access denied. Check the selected profile and its service credentials.'
      : status === 409
        ? 'The operation conflicts with current state. Read the latest state and revision before retrying.'
        : (messages[code] ??
          'The operation failed. Check service readiness and request arguments. A write may already have succeeded; inspect its state before retrying.')
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }]
  }
}

export const createResearchMcpServer = ({
  configRoot,
  version,
  connect = connectToOpenScience
}) => {
  const server = new McpServer({ name: 'open-science', version })
  const lifetime = new AbortController()
  const register = (name, description, shape, annotations, invoke) => {
    server.registerTool(
      name,
      {
        description,
        inputSchema: z.strictObject(shape),
        outputSchema: z.object({ result: z.unknown() }),
        annotations
      },
      async (args, extra) => {
        const signal = AbortSignal.any([lifetime.signal, extra.signal])
        try {
          signal.throwIfAborted()
          // Rediscover per call so service restarts/token rotation recover without retrying writes.
          const client = await connect({ configRoot, signal })
          signal.throwIfAborted()
          return result(await invoke(client, args, { signal }))
        } catch (error) {
          return toolError(error)
        }
      }
    )
  }
  register(
    'doctor',
    'Check whether the running Open-Science service is ready to execute research tasks. Does not start or configure the service.',
    {},
    read,
    (client, _args, options) => client.doctor(options)
  )
  register(
    'list_runtimes',
    'List detected Agent runtimes and readiness. Does not install runtimes or change the selected framework.',
    {},
    read,
    (client, _args, options) => client.listRuntimes(options)
  )
  register(
    'list_projects',
    'List projects and their IDs before choosing a research destination.',
    {},
    read,
    (client, _args, options) => client.listProjects(options)
  )
  register(
    'create_project',
    'Create a persistent research project. Agent Context applies to future work in this project.',
    {
      name: id('Project name.'),
      description: z.string().optional(),
      agentContext: agentContext.optional()
    },
    write,
    (client, args, options) => client.createProject(args, options)
  )
  register(
    'update_project',
    'Update a persistent project. Only supplied fields change; null clears Agent Context.',
    {
      projectId,
      name: id('New project name.').optional(),
      description: z.string().optional(),
      agentContext: agentContext.nullable().optional()
    },
    write,
    (client, { projectId, ...patch }, options) => client.updateProject(projectId, patch, options)
  )
  register(
    'list_sessions',
    'List sessions, optionally within one project. Use the returned ID to inspect or continue a session.',
    {
      projectId: projectId.optional()
    },
    read,
    (client, args, options) => client.listSessions(args.projectId, options)
  )
  register(
    'get_session',
    'Read session information and current status. This is not a full conversation transcript.',
    { sessionId },
    read,
    (client, args, options) => client.getSession(args.sessionId, options)
  )
  register(
    'get_session_configuration',
    'Read current session configuration and revision before changing it.',
    { sessionId },
    read,
    (client, args, options) => client.getSessionConfiguration(args.sessionId, options)
  )
  register(
    'update_session_configuration',
    'Update persistent session settings using the latest revision. May change model costs and execution permissions; only supplied fields change.',
    {
      sessionId,
      expectedRevision,
      ...sessionSettings,
      computeHosts: z
        .strictObject({
          enabled: z.array(id('Enabled Compute Host ID.')),
          selected: z.array(id('Selected Compute Host ID.'))
        })
        .optional()
    },
    write,
    (client, { sessionId, ...patch }, options) =>
      client.updateSessionConfiguration(sessionId, patch, options)
  )
  register(
    'start_run',
    'Submit research in a project and immediately return a run ID. Omit sessionId to create a session, or provide it to continue that session through its existing active branch. May write files/data and incur model charges. Poll get_run; disconnecting does not cancel the run. Uses configured framework and permissions, without automatically approving human interactions.',
    {
      projectId,
      prompt: id('Research instructions.'),
      sessionId: sessionId.optional(),
      cwd: id('Working directory on the Open-Science host.').optional(),
      ...sessionSettings,
      skillIds: z.array(id('Skill ID.')).optional(),
      specialist: id('Specialist ID or exact name for a new session.').optional(),
      turnIntent: z
        .literal('plan-first')
        .describe('Require an approved plan before execution.')
        .optional(),
      permissionPrompts: z
        .literal('none')
        .describe(
          'Deny unresolved human interactions instead of waiting; does not expand permissions. Incompatible with plan-first.'
        )
        .optional(),
      computeHostIds: z.array(id('Selected Compute Host ID.')).optional(),
      enabledComputeHostIds: z.array(id('Enabled Compute Host ID for a new session.')).optional()
    },
    write,
    (client, { projectId, ...request }, options) => {
      if (request.turnIntent === 'plan-first' && request.permissionPrompts === 'none') {
        throw new OpenScienceApiError('Incompatible permission and planning options.', {
          code: 'invalid_request'
        })
      }
      return client.startRun({ project: projectId, ...request }, options)
    }
  )
  register(
    'get_run',
    'Read authoritative run status, progress, result and attention state. Poll this after start_run; a waiting run may require human action in Open-Science.',
    { runId },
    read,
    (client, args, options) => client.getRun(args.runId, options)
  )
  register(
    'cancel_run',
    'Explicitly cancel a research run and wait for service finalization. This does not undo files, data or costs already produced.',
    { runId },
    write,
    (client, args, options) => client.cancelRun(args.runId, options)
  )
  register(
    'get_plan',
    'Read the current session plan, artifact version and revision, or null when there is no plan.',
    { sessionId },
    read,
    (client, args, options) => client.getSessionPlan(args.sessionId, options)
  )
  register(
    'respond_plan',
    'Explicitly approve or reject the reviewed plan version, or request revision with feedback. Approval may resume execution and incur costs. Never approve without reviewing get_plan.',
    {
      sessionId,
      response: z.union([
        z.strictObject({
          decision: z.enum(['approved', 'rejected']),
          artifactVersionId: id('Plan artifact version returned by get_plan.'),
          expectedRevision
        }),
        z.strictObject({ feedback: id('Requested changes to the plan.') })
      ])
    },
    write,
    (client, args, options) => client.respondSessionPlan(args.sessionId, args.response, options)
  )
  register(
    'list_artifacts',
    'List generated artifact metadata for a session. Does not download files or write local paths.',
    { sessionId },
    read,
    (client, args, options) => client.listArtifacts(args.sessionId, options)
  )

  const onclose = server.server.onclose
  server.server.onclose = () => {
    lifetime.abort()
    onclose?.()
  }
  return server
}

export const runResearchMcpServer = async (options) => {
  const server = createResearchMcpServer(options)
  const transport = new StdioServerTransport()
  let closing
  const close = () => {
    closing ??= server.close().finally(() => {
      process.stdin.off('end', close)
      process.off('SIGINT', close)
      process.off('SIGTERM', close)
    })
    return closing
  }
  process.stdin.once('end', close)
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
  try {
    await server.connect(transport)
    if (process.stdin.readableEnded) await close()
  } catch (error) {
    await close()
    throw error
  }
}
