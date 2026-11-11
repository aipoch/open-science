/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { connectToOpenScience, OpenScienceApiError } from './index.mjs'

const id = (description) => z.string().trim().min(1).describe(description)
const sessionId = id('Session ID returned by list_sessions or start_run.')
const projectId = id('Project ID returned by list_projects or create_project.')
const runId = id('Run ID returned by start_run.')
const literatureItemId = id('Literature item ID returned by search_literature.')
const literatureItemIds = z.array(literatureItemId).min(1).max(1000)
const collectionId = id('Literature collection ID returned by create_literature_collection.')
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
// Local Literature writes: no external effects; membership/status updates converge on repeat.
const libraryWrite = { ...write, openWorldHint: false }
const libraryUpdate = { ...libraryWrite, idempotentHint: true }
const libraryAdd = { ...libraryWrite, destructiveHint: false }
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
    literature_item_not_found: 'Literature item not found. Refresh search_literature.',
    literature_project_link_failed:
      'Records were imported but not linked to the Project. Do not repeat the import; call update_project_literature with the returned itemIds.',
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
  // Committed item IDs are service-generated identifiers, not error bodies.
  const itemIds = code === 'literature_project_link_failed' ? error.itemIds : undefined
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: { code, message, ...(itemIds ? { itemIds } : {}) } })
      }
    ]
  }
}

export const createResearchMcpServer = ({
  configRoot,
  version,
  connect = connectToOpenScience
}) => {
  const server = new McpServer({ name: 'open-science', version })
  const lifetime = new AbortController()
  const register = (name, description, shape, annotations, invoke, refine) => {
    const inputSchema = z.strictObject(shape)
    server.registerTool(
      name,
      {
        description,
        inputSchema: refine ? inputSchema.superRefine(refine) : inputSchema,
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
  register(
    'search_literature',
    'Search Literature library records by title, author, abstract or identifier; omit query to browse. Optionally limit results to one project. Returns at most 20 records per page; pass nextOffset as offset to continue. Does not search external providers or read PDF full text.',
    {
      query: z.string().trim().min(1).max(2000).optional(),
      projectId: projectId.optional(),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(20).optional()
    },
    read,
    (client, { limit = 20, ...request }, options) =>
      client.searchLiterature({ ...request, limit }, options)
  )
  register(
    'get_literature_item',
    'Read one Literature library record, including bibliographic metadata, attachments and project links.',
    { itemId: literatureItemId },
    read,
    (client, args, options) => client.getLiteratureItem(args.itemId, options)
  )
  register(
    'list_citation_styles',
    'List the built-in and imported citation styles available to format_references.',
    {},
    read,
    (client, _args, options) => client.listCitationStyles(options)
  )
  register(
    'format_references',
    'Format Literature library records as bibliography entries and in-text citations in one citation style, with BibTeX and RIS exports. Does not modify records or write files.',
    {
      itemIds: z.array(literatureItemId).min(1).max(200),
      styleId: id('Citation style ID returned by list_citation_styles.'),
      locale: z.enum(['en-US', 'zh-CN']).optional()
    },
    read,
    (client, { locale = 'en-US', ...request }, options) =>
      client.formatReferences({ ...request, locale }, options)
  )
  register(
    'get_reference_metadata',
    'Resolve bibliographic metadata for a DOI (10.x/...), pmid:<n>, pmcid:PMC<n> or arxiv:<id> through external registries. Does not add the record to the library.',
    { identifier: id('DOI, pmid:, pmcid: or arxiv: identifier.').max(2048) },
    { ...read, openWorldHint: true },
    (client, args, options) => client.getReferenceMetadata(args.identifier, options)
  )
  register(
    'import_literature',
    'Import BibTeX, RIS or NBIB text, or item objects, into the Literature library. Call with mode "preview" first to inspect entries, duplicates and warnings without saving; then call "commit" with the same source. duplicatePolicy defaults to reuse. Optionally add committed records to a collection and link them to a project.',
    {
      mode: z.enum(['preview', 'commit']),
      content: z.string().min(1).optional(),
      items: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .max(1000)
        .describe('Item objects in the get_literature_item "item" shape.')
        .optional(),
      selectedItemIndexes: z.array(z.number().int().nonnegative()).min(1).max(1000).optional(),
      duplicatePolicy: z.enum(['reuse', 'separate', 'fill-missing']).optional(),
      collectionId: collectionId.optional(),
      projectId: projectId.optional()
    },
    libraryAdd,
    (client, request, options) => client.importLiterature(request, options),
    (request, context) => {
      if ((request.content === undefined) === (request.items === undefined))
        context.addIssue({ code: 'custom', message: 'Provide exactly one of content or items.' })
      if (
        request.mode === 'preview' &&
        (request.duplicatePolicy || request.collectionId || request.projectId)
      )
        context.addIssue({
          code: 'custom',
          message: 'Preview does not accept import destinations.'
        })
    }
  )
  register(
    'create_literature_item',
    'Add one record to the Literature library from a DOI, pmid:<n>, pmcid:PMC<n> or arxiv:<id>. Metadata is resolved through external registries; an existing record with the same identifier is reused.',
    { identifier: id('DOI, pmid:, pmcid: or arxiv: identifier.').max(2048) },
    { ...libraryAdd, idempotentHint: true, openWorldHint: true },
    (client, args, options) => client.createLiteratureItem(args.identifier, options)
  )
  register(
    'update_project_literature',
    'Link Literature records to a project, or unlink them with included false. Unlinking does not delete records.',
    { projectId, itemIds: literatureItemIds, included: z.boolean() },
    libraryUpdate,
    (client, args, options) =>
      client.setProjectLiterature(args.projectId, args.itemIds, args.included, options)
  )
  register(
    'create_literature_collection',
    'Create a Literature collection, optionally nested under a parent collection. Collection names must be unique.',
    {
      name: id('Collection name.').max(200),
      description: z.string().trim().max(1000).optional(),
      parentId: collectionId.optional()
    },
    libraryAdd,
    (client, args, options) => client.createLiteratureCollection(args, options)
  )
  register(
    'update_collection_items',
    'Add Literature records to a collection, or remove them with included false. Removing does not delete records.',
    { collectionId, itemIds: literatureItemIds, included: z.boolean() },
    libraryUpdate,
    (client, args, options) =>
      client.setCollectionLiterature(args.collectionId, args.itemIds, args.included, options)
  )
  register(
    'set_reading_status',
    'Set the personal reading status of Literature records.',
    { itemIds: literatureItemIds, readingStatus: z.enum(['unread', 'reading', 'read']) },
    libraryUpdate,
    (client, args, options) =>
      client.setLiteratureReadingStatus(args.itemIds, args.readingStatus, options)
  )
  register(
    'set_literature_lifecycle',
    'Move Literature records to the trash with state "deleted", or restore them with "active". Records are not permanently deleted.',
    { itemIds: literatureItemIds, state: z.enum(['active', 'deleted']) },
    libraryUpdate,
    (client, args, options) => client.setLiteratureLifecycle(args.itemIds, args.state, options)
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
