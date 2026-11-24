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
const registerResource = (...definition) => addCapability({ cli: true, mcp: true }, ...definition)

registerResource(
  'list_runtimes',
  'setup',
  'List detected Agent runtimes and readiness. Does not install runtimes or change the selected framework.',
  {},
  read,
  (client, _args, options) => client.listRuntimes(options),
  undefined,
  { serviceCapability: 'list-runtimes' }
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
  'Submit research and return its durable receipt. If the work needs a known Notebook language, check get_setup_status for that language before submitting. Keep requestId before sending. Omit sessionId to create a Session. To continue an existing Session, pass requestId, projectId, sessionId, and prompt; omit provider, model, reasoning effort, memory, and enabled Compute Hosts so the existing configuration is used. Change those separately with update_session_configuration. A pending receipt has no runId yet: use wait_submission with requestId, then use the returned runId to observe the Run. Query get_submission after disconnect. Uses the configured permissions and can incur model charges.',
  {
    requestId,
    projectId,
    prompt: id('Research instructions.'),
    sessionId: sessionId.optional(),
    cwd: id(
      'An existing working directory on the Open-Science host. Omit to use the Project or existing Session default.'
    ).optional(),
    notebookLanguage: z
      .enum(['python', 'r'])
      .describe('Use with notebookRuntimeId to bind a specific interpreter. Otherwise omit both.')
      .optional(),
    notebookRuntimeId: z
      .string()
      .min(1)
      .max(4096)
      .describe(
        'Exact enabled runtimeId from list_notebook_runtimes; supply with notebookLanguage.'
      )
      .optional(),
    ...agentConfiguration.shape,
    ...sessionPreferences,
    permissionPrompts: z
      .literal('none')
      .describe('Deny requests that still need a person.')
      .optional(),
    interactionMode: z
      .enum(['relay', 'delegate'])
      .describe(
        'Default: relay. Use delegate only after the user delegates routine decisions for this task.'
      )
      .optional(),
    otelTraces: z
      .literal(true)
      .describe(
        'Export Open-Science Agent traces for this Run; supported on local durable submissions.'
      )
      .optional(),
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
    {
      requestId,
      projectId,
      providerId,
      model,
      reasoningEffort,
      notebookLanguage,
      notebookRuntimeId,
      ...request
    },
    options
  ) =>
    projectSubmissionReceipt(
      await client.submitRun(
        requestId,
        {
          project: projectId,
          ...request,
          ...(notebookLanguage
            ? { notebookRuntime: { language: notebookLanguage, runtimeId: notebookRuntimeId } }
            : {}),
          ...(providerId !== undefined || model !== undefined || reasoningEffort !== undefined
            ? { agentConfiguration: { providerId, model, reasoningEffort } }
            : {})
        },
        options
      ),
      client.configRoot
    ),
  (
    { permissionPrompts, turnIntent, interactionMode, notebookLanguage, notebookRuntimeId },
    context
  ) => {
    if ((notebookLanguage === undefined) !== (notebookRuntimeId === undefined))
      context.addIssue({
        code: 'custom',
        message: 'Supply notebookLanguage and notebookRuntimeId together.'
      })
    if (permissionPrompts === 'none' && turnIntent === 'plan-first')
      context.addIssue({ code: 'custom', message: 'A Plan requires an available human approver.' })
    if (permissionPrompts === 'none' && interactionMode === 'delegate')
      context.addIssue({ code: 'custom', message: 'Task delegation requires permission prompts.' })
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
  'Read the Run status, its Notebook evidence and linked continuations. Follow a continuation runId for its own interactions and results.',
  { runId },
  read,
  (client, args, options) => client.getRun(args.runId, options)
)
registerResource(
  'wait_run',
  'research',
  'Wait for a Run to finish or need attention, including Notebook environment review, code review, or continuation. Timeout only stops observation.',
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
  'continue_notebook',
  'research',
  "Relay the user's explicit decision to continue this specific Notebook stop. Copy the original Run, branch and refusal IDs and use a new requestId that you keep before sending. This starts a new turn in the same Session and rechecks execution conditions; it does not retry a stopped cell. If the response is lost, query get_submission with the same ID.",
  {
    requestId,
    runId,
    branchId: id('Message branch from the current Notebook stop.'),
    refusalId: id('Refusal ID from the current Notebook stop.'),
    source: z.literal('user_relay').describe("Relay the user's explicit decision for this stop."),
    prompt: id('Instructions for continuing the authorized Notebook work.')
  },
  { ...write, idempotentHint: true },
  async (client, { requestId, ...request }, options) =>
    projectSubmissionReceipt(
      await client.continueNotebook(requestId, request, options),
      client.configRoot
    ),
  undefined,
  { serviceCapability: 'notebook-continuation' }
)
registerResource(
  'cancel_run',
  'research',
  'Explicitly cancel a research run and wait for service finalization. This does not undo files, data or costs already produced.',
  { runId },
  write,
  (client, args, options) => client.cancelRun(args.runId, options)
)
const interactionScope = {
  runId: runId.optional(),
  projectId: projectId.optional(),
  sessionId: sessionId.optional()
}

const requireInteractionScope = ({ runId, projectId, sessionId }, context) => {
  if (!(runId ? !projectId && !sessionId : projectId && sessionId)) {
    context.addIssue({ code: 'custom', message: 'Supply runId or both projectId and sessionId.' })
  }
}

const decisionSource = {
  source: z.enum(['user_relay', 'delegated_agent']),
  expectedModeRevision: z.number().int().nonnegative().optional()
}
const requireDelegationRevision = ({ source, expectedModeRevision }, context) => {
  if ((source === 'delegated_agent') !== (expectedModeRevision !== undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'Supply expectedModeRevision only for a delegated_agent decision.'
    })
  }
}

registerResource(
  'list_interactions',
  'research',
  'Find interactions needing attention in one Run or an explicit Project and Session. Query again after reconnect; no browser or host elicitation is required.',
  interactionScope,
  read,
  (client, scope, options) => client.listInteractions(scope, options),
  requireInteractionScope,
  { serviceCapability: 'task-interactions' }
)
registerResource(
  'get_interaction',
  'research',
  'Read the exact interaction, legal actions, current revision, or recorded decision in the scope returned by list_interactions.',
  {
    ...interactionScope,
    interactionId: id('Copy the full interaction ID from list_interactions, including its prefix.')
  },
  read,
  (client, { interactionId, ...scope }, options) =>
    client.getInteraction(interactionId, scope, options),
  requireInteractionScope,
  { serviceCapability: 'task-interactions' }
)
registerResource(
  'respond_permission',
  'research',
  'Select a one-time option for the exact pending permission, including Notebook environment and code reviews. For a Notebook review, copy notebookReview.language into expectedLanguage. Use user_relay for a user decision, or delegated_agent with the current Run interaction policy revision.',
  {
    ...interactionScope,
    interactionId: id('Permission interaction ID from get_interaction.'),
    optionId: id('One of the options in the current interaction.'),
    expectedRevision,
    expectedBranchId: id('Branch ID from get_interaction.'),
    expectedLanguage: z.enum(['python', 'r', 'repl', 'bash']).optional(),
    ...decisionSource
  },
  write,
  (client, { runId, projectId, sessionId, interactionId, ...response }, options) =>
    client.respondPermission(
      interactionId,
      runId ? { runId } : { projectId, sessionId },
      response,
      options
    ),
  (args, context) => {
    requireInteractionScope(args, context)
    requireDelegationRevision(args, context)
  },
  { serviceCapability: 'task-permissions' }
)
registerResource(
  'set_run_interaction_mode',
  'research',
  'Set relay or delegate on one Run using its current interactionPolicy.revision. Delegate only when the user asks; use relay to withdraw. Does not change Session or global permissions.',
  { runId, expectedRevision, interactionMode: z.enum(['relay', 'delegate']) },
  write,
  (client, { runId, ...fields }, options) => client.setRunInteractionMode(runId, fields, options),
  undefined,
  { serviceCapability: 'task-delegation' }
)
registerResource(
  'answer_question',
  'research',
  'Answer the exact AskUser question read through get_interaction. Use known_context only for information the user already supplied; otherwise ask the user and relay their answer. If the answer is unknown, leave the question pending. An answer does not authorize tools or grant permissions.',
  {
    ...interactionScope,
    interactionId: id('AskUser interaction ID from get_interaction.'),
    expectedRevision,
    expectedBranchId: id('Branch ID from the reviewed interaction.'),
    source: z.enum(['user_relay', 'known_context']),
    action: z.enum(['accept', 'decline']),
    answers: z
      .array(
        z.union([
          z.strictObject({ fieldId: id('Field ID.'), status: z.literal('skipped') }),
          z.strictObject({
            fieldId: id('Field ID.'),
            status: z.literal('answered').optional(),
            value: z.union([
              z.string().max(4000),
              z.number(),
              z.boolean(),
              z.array(z.string().max(1000)).max(64)
            ])
          })
        ])
      )
      .max(16)
      .optional()
  },
  write,
  (client, { runId, projectId, sessionId, interactionId, ...response }, options) =>
    client.answerQuestion(
      interactionId,
      runId ? { runId } : { projectId, sessionId },
      response,
      options
    ),
  (input, context) => {
    requireInteractionScope(input, context)
    if (input.action === 'decline' && input.answers?.length) {
      context.addIssue({ code: 'custom', message: 'Declining does not take field answers.' })
    }
  },
  { serviceCapability: 'task-questions' }
)
registerResource(
  'get_plan',
  'research',
  'Read the current session plan, artifact version and revision, or null when there is no plan.',
  { sessionId },
  read,
  (client, args, options) => client.getSessionPlan(args.sessionId, options)
)
registerResource(
  'respond_plan',
  'research',
  'Respond to a reviewed Plan as user_relay for a specific user decision, or delegated_agent with the current task delegation revision. Approval can resume execution and incur costs.',
  {
    sessionId,
    projectId: projectId.optional(),
    artifactVersionId: id('Plan Artifact Version from get_interaction or get_plan.'),
    expectedRevision,
    expectedBranchId: id('Branch ID from get_interaction or get_plan.'),
    ...decisionSource,
    decision: z.enum(['approved', 'rejected']).optional(),
    feedback: id('Requested changes to the Plan.').optional()
  },
  write,
  (client, { sessionId, ...response }, options) =>
    client.respondSessionPlan(sessionId, response, options),
  ({ decision, feedback, ...args }, context) => {
    if (Boolean(decision) === Boolean(feedback)) {
      context.addIssue({ code: 'custom', message: 'Supply one decision or feedback.' })
    }
    requireDelegationRevision(args, context)
  },
  { serviceCapability: 'task-interactions' }
)
registerResource(
  'search_literature',
  'literature',
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
  'literature',
  'Read one Literature library record, including bibliographic metadata, attachments and project links.',
  { itemId: literatureItemId },
  read,
  (client, args, options) => client.getLiteratureItem(args.itemId, options)
)
registerResource(
  'list_citation_styles',
  'literature',
  'List the built-in and imported citation styles available to format_references.',
  {},
  read,
  (client, _args, options) => client.listCitationStyles(options)
)
registerResource(
  'format_references',
  'literature',
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
  'literature',
  'Resolve bibliographic metadata for a DOI (10.x/...), pmid:<n>, pmcid:PMC<n> or arxiv:<id> through external registries. Does not add the record to the library.',
  { identifier: id('DOI, pmid:, pmcid: or arxiv: identifier.').max(2048) },
  { ...read, openWorldHint: true },
  (client, args, options) => client.getReferenceMetadata(args.identifier, options)
)
registerResource(
  'import_literature',
  'literature',
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
  'literature',
  'Add one record to the Literature library from a DOI, pmid:<n>, pmcid:PMC<n> or arxiv:<id>. Metadata is resolved through external registries; an existing record with the same identifier is reused.',
  { identifier: id('DOI, pmid:, pmcid: or arxiv: identifier.').max(2048) },
  { ...libraryAdd, idempotentHint: true, openWorldHint: true },
  (client, args, options) => client.createLiteratureItem(args.identifier, options)
)
registerResource(
  'update_project_literature',
  'literature',
  'Link Literature records to a project, or unlink them with included false. Unlinking does not delete records.',
  { projectId, itemIds: literatureItemIds, included: z.boolean() },
  libraryUpdate,
  (client, args, options) =>
    client.setProjectLiterature(args.projectId, args.itemIds, args.included, options)
)
registerResource(
  'create_literature_collection',
  'literature',
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
  'literature',
  'Add Literature records to a collection, or remove them with included false. Removing does not delete records.',
  { collectionId, itemIds: literatureItemIds, included: z.boolean() },
  libraryUpdate,
  (client, args, options) =>
    client.setCollectionLiterature(args.collectionId, args.itemIds, args.included, options)
)
registerResource(
  'set_reading_status',
  'literature',
  'Set the personal reading status of Literature records.',
  { itemIds: literatureItemIds, readingStatus: z.enum(['unread', 'reading', 'read']) },
  libraryUpdate,
  (client, args, options) =>
    client.setLiteratureReadingStatus(args.itemIds, args.readingStatus, options)
)
registerResource(
  'set_literature_lifecycle',
  'literature',
  'Move Literature records to the trash with state "deleted", or restore them with "active". Records are not permanently deleted.',
  { itemIds: literatureItemIds, state: z.enum(['active', 'deleted']) },
  libraryUpdate,
  (client, args, options) => client.setLiteratureLifecycle(args.itemIds, args.state, options)
)
