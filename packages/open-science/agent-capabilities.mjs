/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { z } from 'zod'
import { projectSubmissionReceipt } from './agent-setup-action.mjs'
import { OpenScienceApiError } from './index.mjs'

const id = (description) => z.string().trim().min(1).describe(description)
const sessionId = id('Session ID returned by list_sessions or start_run.')
const projectId = id('Project ID returned by list_projects or create_project.')
const runId = id('Run ID returned by the submission receipt.')
const requestId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/)
  .describe('Stable request ID. Generate and keep it before you submit.')
export const waitTimeoutMs = z
  .number()
  .int()
  .min(1)
  .max(30_000)
  .default(10_000)
  .describe('Maximum milliseconds to observe the original request. Does not cancel it.')
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
const sessionPreferences = {
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
const expectedUpdatedAt = z
  .number()
  .int()
  .positive()
  .describe('Current updatedAt from the read operation.')
const hostIds = z.array(id('Compute Host ID.')).optional()
const hostFields = {
  enabledComputeHostIds: hostIds.describe(
    'Supply with selectedComputeHostIds to replace Compute Hosts.'
  ),
  selectedComputeHostIds: hostIds.describe(
    'Supply with enabledComputeHostIds; selected hosts must be enabled.'
  )
}

const configurationPatch = ({
  providerId,
  model,
  reasoningEffort,
  enabledComputeHostIds,
  selectedComputeHostIds,
  clearAgentConfiguration,
  clearComputeHosts,
  ...patch
}) => {
  const agent = { providerId, model, reasoningEffort }
  const setAgent = Object.values(agent).some((value) => value !== undefined)
  const setHosts = enabledComputeHostIds !== undefined || selectedComputeHostIds !== undefined
  if (
    (clearAgentConfiguration && setAgent) ||
    (clearComputeHosts && setHosts) ||
    (setHosts && (enabledComputeHostIds === undefined || selectedComputeHostIds === undefined))
  ) {
    throw new OpenScienceApiError('Conflicting or incomplete configuration fields.', {
      code: 'invalid_request'
    })
  }
  return {
    ...patch,
    ...(clearAgentConfiguration
      ? { agentConfiguration: null }
      : setAgent
        ? { agentConfiguration: agent }
        : {}),
    ...(clearComputeHosts
      ? { computeHosts: null }
      : setHosts
        ? { computeHosts: { enabled: enabledComputeHostIds, selected: selectedComputeHostIds } }
        : {})
  }
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

export const existingMcpCapabilities = []

const addCapability = (
  exposure,
  name,
  group,
  description,
  shape,
  annotations,
  invoke,
  refine,
  { serviceCapability, boundedWait = false } = {}
) => {
  const schema = z.strictObject(shape)
  existingMcpCapabilities.push({
    name,
    group,
    description,
    inputSchema: refine ? schema.superRefine(refine) : schema,
    annotations,
    exposure,
    serviceCapability,
    probeOnly: boundedWait,
    async handler(args, { getClient, signal }) {
      if (boundedWait) {
        const timeout = AbortSignal.timeout(args.timeoutMs)
        signal = signal ? AbortSignal.any([signal, timeout]) : timeout
      }
      return invoke(await getClient(signal), args, { signal })
    }
  })
}
const register = (...definition) => addCapability({ mcp: true }, ...definition)
const registerResource = (...definition) => addCapability({ cli: true, mcp: true }, ...definition)

register(
  'list_runtimes',
  'setup',
  'List detected Agent runtimes and readiness. Does not install runtimes or change the selected framework.',
  {},
  read,
  (client, _args, options) => client.listRuntimes(options)
)
registerResource(
  'list_projects',
  'research',
  'List projects and their IDs before choosing a research destination.',
  {},
  read,
  (client, _args, options) => client.listProjects(options)
)
registerResource(
  'create_project',
  'research',
  'Create a persistent research project. Agent Context applies to future work in this project.',
  {
    name: id('Project name.'),
    description: z.string().optional(),
    agentContext: agentContext.optional()
  },
  write,
  (client, args, options) => client.createProject(args, options)
)
registerResource(
  'update_project',
  'research',
  'Update a persistent project. Only supplied fields change; null clears Agent Context.',
  {
    projectId,
    expectedUpdatedAt,
    name: id('New project name.').optional(),
    description: z.string().optional(),
    agentContext: agentContext.nullable().optional()
  },
  write,
  (client, { projectId, agentContext, ...patch }, options) =>
    client.updateProject(
      projectId,
      {
        ...patch,
        ...(agentContext !== undefined ? { agentContext: agentContext ?? '' } : {})
      },
      options
    )
)
registerResource(
  'get_project_session_defaults',
  'research',
  'Read configured defaults for new Task API Sessions in one Project and the current updatedAt.',
  { projectId },
  read,
  (client, args, options) => client.getProjectSessionDefaults(args.projectId, options)
)
registerResource(
  'update_project_session_defaults',
  'research',
  'Update defaults for new Task API Sessions in one Project. Use the current updatedAt. Null clears a preference.',
  {
    projectId,
    expectedUpdatedAt,
    ...agentConfiguration.shape,
    ...Object.fromEntries(
      Object.entries(sessionPreferences).map(([key, schema]) => [key, schema.nullable()])
    ),
    ...hostFields,
    specialistId: id('Specialist ID. Null clears the default.').nullable().optional(),
    clearAgentConfiguration: z
      .literal(true)
      .describe('Remove the configured Agent default.')
      .optional(),
    clearComputeHosts: z
      .literal(true)
      .describe('Remove the configured Compute Host defaults.')
      .optional()
  },
  write,
  (client, { projectId, expectedUpdatedAt, ...fields }, options) =>
    client.updateProjectSessionDefaults(
      projectId,
      { expectedUpdatedAt, patch: configurationPatch(fields) },
      options
    )
)
registerResource(
  'list_sessions',
  'research',
  'List sessions, optionally within one project. Use the returned ID to inspect or continue a session.',
  {
    projectId: projectId.optional()
  },
  read,
  (client, args, options) => client.listSessions(args.projectId, options)
)
registerResource(
  'get_session',
  'research',
  'Inspect Session identity, import or Fork provenance, and the current Notebook intent. Recheck this Session after the user continues stopped Notebook work.',
  { sessionId, projectId: projectId.optional() },
  read,
  (client, { sessionId, projectId }, options) =>
    client.getSession(sessionId, { ...options, projectId })
)
registerResource(
  'get_session_configuration',
  'research',
  'Read current session configuration and revision before changing it.',
  { sessionId, projectId: projectId.optional() },
  read,
  (client, { sessionId, projectId }, options) =>
    client.getSessionConfiguration(sessionId, { ...options, projectId })
)
registerResource(
  'update_session_configuration',
  'research',
  'Update persistent session settings using the latest revision. May change model costs and execution permissions; only supplied fields change.',
  {
    sessionId,
    projectId: projectId.optional(),
    expectedRevision,
    ...agentConfiguration.shape,
    ...sessionPreferences,
    ...hostFields
  },
  write,
  (client, { sessionId, ...fields }, options) =>
    client.updateSessionConfiguration(sessionId, configurationPatch(fields), options)
)
registerResource(
  'start_run',
  'research',
  'Submit research and return its durable receipt. Keep requestId before sending. Omit sessionId to create a Session. To continue an existing Session, pass requestId, projectId, sessionId, and prompt; omit provider, model, reasoning effort, memory, and enabled Compute Hosts so the existing configuration is used. Change those separately with update_session_configuration. A pending receipt has no runId yet: use wait_submission with requestId, then use the returned runId to observe the Run. Query get_submission after disconnect. Uses the configured permissions and can incur model charges.',
  {
    requestId,
    projectId,
    prompt: id('Research instructions.'),
    sessionId: sessionId.optional(),
    cwd: id(
      'An existing working directory on the Open-Science host. Omit to use the Project or existing Session default.'
    ).optional(),
    ...agentConfiguration.shape,
    ...sessionPreferences,
    permissionPrompts: z.literal('none').describe('Deny requests that still need a person.').optional(),
    skillIds: z.array(id('Skill ID.')).optional(),
    specialist: id('Specialist ID or exact name for a new session.').optional(),
    turnIntent: z
      .literal('plan-first')
      .describe('Require an approved plan before execution.')
      .optional(),
    computeHostIds: z.array(id('Selected Compute Host ID.')).optional(),
    enabledComputeHostIds: z.array(id('Enabled Compute Host ID for a new session.')).optional()
  },
  { ...write, idempotentHint: true },
  async (
    client,
    { requestId, projectId, providerId, model, reasoningEffort, ...request },
    options
  ) =>
    projectSubmissionReceipt(
      await client.submitRun(
        requestId,
        {
          project: projectId,
          ...request,
          ...(providerId !== undefined || model !== undefined || reasoningEffort !== undefined
            ? { agentConfiguration: { providerId, model, reasoningEffort } }
            : {})
        },
        options
      ),
      client.configRoot
    ),
  ({ permissionPrompts, turnIntent }, context) => {
    if (permissionPrompts === 'none' && turnIntent === 'plan-first')
      context.addIssue({ code: 'custom', message: 'A Plan requires an available human approver.' })
  },
  { serviceCapability: 'durable-submissions' }
)
registerResource(
  'get_submission',
  'research',
  'Read the original durable receipt by requestId. A missing receipt is not a reason to submit with a new ID.',
  { requestId },
  read,
  async (client, args, options) =>
    projectSubmissionReceipt(
      await client.getSubmission(args.requestId, options),
      client.configRoot
    ),
  undefined,
  { serviceCapability: 'durable-submissions' }
)
registerResource(
  'wait_submission',
  'research',
  'Wait by requestId for the original receipt to leave pending. An accepted receipt has the runId for get_run or wait_run. Failed and interrupted receipts are returned as recorded; timeout only stops observation.',
  { requestId, timeoutMs: waitTimeoutMs },
  read,
  async (client, { requestId, timeoutMs }, options) => ({
    timeoutMs,
    receipt: projectSubmissionReceipt(
      await client.waitForSubmission(requestId, { ...options, timeoutMs, returnReceipt: true }),
      client.configRoot
    )
  }),
  undefined,
  { serviceCapability: 'durable-submissions', boundedWait: true }
)
registerResource(
  'get_run',
  'research',
  'Read outer Run status and separate Notebook execution evidence. A completed Run alone does not establish execution or delivery.',
  { runId },
  read,
  (client, args, options) => client.getRun(args.runId, options)
)
registerResource(
  'wait_run',
  'research',
  'Wait for a Run to finish or need attention, including Notebook code review or continuation. Timeout only stops observation.',
  { runId, timeoutMs: waitTimeoutMs },
  read,
  async (client, { runId, timeoutMs }, options) => ({
    timeoutMs,
    run: await client.waitForRun(runId, { ...options, timeoutMs, returnOnAttention: true })
  }),
  undefined,
  { boundedWait: true }
)
registerResource(
  'cancel_run',
  'research',
  'Explicitly cancel a research run and wait for service finalization. This does not undo files, data or costs already produced.',
  { runId },
  write,
  (client, args, options) => client.cancelRun(args.runId, options)
)
register(
  'get_plan',
  'research',
  'Read the current session plan, artifact version and revision, or null when there is no plan.',
  { sessionId },
  read,
  (client, args, options) => client.getSessionPlan(args.sessionId, options)
)
register(
  'respond_plan',
  'research',
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
registerResource(
  'search_literature',
  'research',
  'Search Literature library records by title, author, abstract or identifier; omit query to browse. Optionally limit results to one project. Pages default to 20 records; pass nextOffset as offset to continue. Does not search external providers or read PDF full text.',
  {
    query: z.string().trim().min(1).max(2000).optional(),
    projectId: projectId.optional(),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(100).default(20)
  },
  read,
  (client, request, options) => client.searchLiterature(request, options)
)
registerResource(
  'get_literature_item',
  'research',
  'Read one Literature library record, including bibliographic metadata, attachments and project links.',
  { itemId: literatureItemId },
  read,
  (client, args, options) => client.getLiteratureItem(args.itemId, options)
)
registerResource(
  'list_citation_styles',
  'research',
  'List the built-in and imported citation styles available to format_references.',
  {},
  read,
  (client, _args, options) => client.listCitationStyles(options)
)
registerResource(
  'format_references',
  'research',
  'Format Literature library records as bibliography entries and in-text citations in one citation style, with BibTeX and RIS exports. Does not modify records or write files.',
  {
    itemIds: z.array(literatureItemId).min(1).max(200),
    styleId: id('Citation style ID returned by list_citation_styles.'),
    locale: z.enum(['en-US', 'zh-CN']).default('en-US')
  },
  read,
  (client, request, options) => client.formatReferences(request, options)
)
registerResource(
  'get_reference_metadata',
  'research',
  'Resolve bibliographic metadata for a DOI (10.x/...), pmid:<n>, pmcid:PMC<n> or arxiv:<id> through external registries. Does not add the record to the library.',
  { identifier: id('DOI, pmid:, pmcid: or arxiv: identifier.').max(2048) },
  { ...read, openWorldHint: true },
  (client, args, options) => client.getReferenceMetadata(args.identifier, options)
)
registerResource(
  'import_literature',
  'research',
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
    duplicatePolicy: z
      .enum(['reuse', 'separate', 'fill-missing'])
      .describe('Commit only; defaults to reuse.')
      .optional(),
    collectionId: collectionId.optional(),
    projectId: projectId.optional()
  },
  libraryAdd,
  (client, request, options) =>
    client.importLiterature(
      request.mode === 'commit' ? { duplicatePolicy: 'reuse', ...request } : request,
      options
    ),
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
registerResource(
  'create_literature_item',
  'research',
  'Add one record to the Literature library from a DOI, pmid:<n>, pmcid:PMC<n> or arxiv:<id>. Metadata is resolved through external registries; an existing record with the same identifier is reused.',
  { identifier: id('DOI, pmid:, pmcid: or arxiv: identifier.').max(2048) },
  { ...libraryAdd, idempotentHint: true, openWorldHint: true },
  (client, args, options) => client.createLiteratureItem(args.identifier, options)
)
registerResource(
  'update_project_literature',
  'research',
  'Link Literature records to a project, or unlink them with included false. Unlinking does not delete records.',
  { projectId, itemIds: literatureItemIds, included: z.boolean() },
  libraryUpdate,
  (client, args, options) =>
    client.setProjectLiterature(args.projectId, args.itemIds, args.included, options)
)
registerResource(
  'create_literature_collection',
  'research',
  'Create a Literature collection, optionally nested under a parent collection. Collection names must be unique.',
  {
    name: id('Collection name.').max(200),
    description: z.string().trim().max(1000).optional(),
    parentId: collectionId.optional()
  },
  libraryAdd,
  (client, args, options) => client.createLiteratureCollection(args, options)
)
registerResource(
  'update_collection_items',
  'research',
  'Add Literature records to a collection, or remove them with included false. Removing does not delete records.',
  { collectionId, itemIds: literatureItemIds, included: z.boolean() },
  libraryUpdate,
  (client, args, options) =>
    client.setCollectionLiterature(args.collectionId, args.itemIds, args.included, options)
)
registerResource(
  'set_reading_status',
  'research',
  'Set the personal reading status of Literature records.',
  { itemIds: literatureItemIds, readingStatus: z.enum(['unread', 'reading', 'read']) },
  libraryUpdate,
  (client, args, options) =>
    client.setLiteratureReadingStatus(args.itemIds, args.readingStatus, options)
)
registerResource(
  'set_literature_lifecycle',
  'research',
  'Move Literature records to the trash with state "deleted", or restore them with "active". Records are not permanently deleted.',
  { itemIds: literatureItemIds, state: z.enum(['active', 'deleted']) },
  libraryUpdate,
  (client, args, options) => client.setLiteratureLifecycle(args.itemIds, args.state, options)
)
