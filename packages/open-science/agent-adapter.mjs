/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { artifactCapabilities } from './agent-artifacts.mjs'
import { existingMcpCapabilities } from './agent-capabilities.mjs'
import { inspectAgentDeliveryDirectory } from './agent-delivery-directory.mjs'
import { projectAgentNotebookReadiness, readinessActions } from './agent-notebook-readiness.mjs'
import { getAgentPackageCapabilities } from './agent-package-capabilities.mjs'
import { openBrowser, setupAction } from './agent-setup-action.mjs'
import { connectToOpenScience } from './index.mjs'

export const agentGuideUri = 'openscience://agent/guide'
export const agentGuide = `# Open-Science for external agents

Run the agent, the Open-Science service, and the MCP process on the same machine with access to the input and delivery files. A remote service path is not a file the agent can read.

Install Open-Science with the application's installer or npm package. Start the selected profile with \`open-science start --no-open\`, or connect a local stdio MCP client to \`open-science mcp\` to start or reuse the service.

Use the capability catalog and detail schemas to find the operations the installed adapter exposes. Check service support and call doctor for the same profile. Base Agent readiness does not prove that a Notebook can run, has run, or produced files.

Use list_runtimes and list_providers to find the runtime, providers, and models supported by this version. Ask the user to choose when they have not made a selection. Select and prepare only an authorized runtime. Save and verify an API connection with save_api_provider, then use activate_provider for the provider and exact model the user chose, including an existing provider. Use configure_provider for the offered keyless option. Supply only a user-chosen stored credential reference or the name of a variable visible to this CLI or MCP process. Never ask for a secret in chat or pass its value as a tool argument. For OAuth, use the supported sign-in handoff or open_setup for the same profile and let the user complete consent. Recheck the same profile afterward. Do not copy or print credentials or private setup URLs.

Notebook status includes Python and R. For a general setup request, report both without picking or installing a language. Check the requested language before research. With authorization, prepare that language using prepare_notebook_environment. Generate and keep an operationId before submitting. After a timeout or disconnect, call get_notebook_environment_operation with the same language and ID. To cancel, use cancel_notebook_environment_operation with that same target and check the result. Use repair_notebook_environment only for a requested repair of the selected app-managed default environment. Recheck readiness after installation: environment setup, binding approval and Notebook execution are separate. System dependencies, isolation and memory can still block execution independently.

Use the user's research instructions and choose an explicit Project. Omit the working directory to use the Project default for a new Session, or the existing Session directory when continuing. The Agent delivery directory is for downloads and may not exist before the first delivery. Generate and keep a request ID before sending. If the response is lost, query the original receipt in the same profile. Waiting only observes work; it does not cancel it. Use a new ID only for a new research turn. The user owns provider consent, each decision to continue a stopped Notebook, and sensitive export confirmation.

If a Run returns interaction attention, call list_interactions with the original Run ID, or with both Project and Session IDs. Use get_interaction to read its current details. For a pending Plan, present the current Plan to the user in this conversation and relay their approval, rejection, or revision feedback with respond_plan and source user_relay. Use the Artifact Version and revision they reviewed. If the response is lost, query the same interaction. A recorded Plan response does not mean the Notebook ran or files were delivered.

For a pending AskUser question, use get_interaction to read the required fields, legal choices, custom fields, and skipFieldIds. Use answer_question with the reviewed revision and branch. Use known_context only when the user already provided the answer; otherwise ask the user and relay it with user_relay. Leave unknown questions pending. Do not guess or automatically skip them. Recheck the original interaction if the answer response is lost. If a recorded answer has a continuation, follow its requestId and runId when available; unconfirmed does not establish execution. An answer grants no permissions.

Read the Run's Notebook execution separately from its outer status. When execution is waiting_for_user, follow its next action. For review_notebook_code_in_app, ask the user to decide the pending review in the original Session and branch in Open-Science on the same profile. Recheck the same Run after the user responds. The agent cannot make the decision or submit a replacement Run.
For review_notebook_runtime_in_app, explain that the selected kernel and environment need the user's approval, even if the environment is installed. The review can be pending before a Notebook Run exists. Use execution.language when present to check the relevant language if needed. Offer to open Notebook settings if the user wants to check or change setup. Ask them to respond to Confirm Notebook kernel and environment in the original Session and branch in the Web or Desktop app on the same profile. Recheck the same Run after the user responds; do not make the decision or submit a replacement Run.

For continue_notebook, read the current stop with get_interaction. Help resolve the reported cause, then ask the user whether to continue this specific stop. Relay their decision with source user_relay, the original runId, branchId and refusalId, a continuation prompt, and a requestId you save before sending. Use get_submission or wait_submission with that ID; an accepted receipt points to a new Run in the same Session. Read that Run for execution and delivery. If the stop has expired, inspect the original Run and ask the user before starting any new work. Never retry a stopped cell or repeat the decision with a fresh ID.

For continue_notebook_in_app, ask the user to open the original Session and branch in the Open-Science desktop app connected to this service and choose Continue Notebook work in Compute after resolving the cause. Recheck the same Session and match continuedFromRefusalId to observe the new user-authorized turn.

Notebook working files are not delivered Artifacts. List the Artifacts for the accepted research runId, download the report and results table, and call get_delivery_status with the downloaded paths. Report execution.status and delivery.status separately. Say the handoff is complete only when handoffStatus is complete. If files verify but a Notebook cell failed, report both facts.

When the user asks to import or inspect a .science package, import it from its absolute local path. An attachment by itself does not request import, execution or Fork. Summarize the returned package inventory, inspect the read-only Session, and list its historical Artifacts as requested. Ask before creating a writable Fork and check the new environment's readiness before research.

After the user agrees to Fork, use the new Session IDs returned inside the Fork result for a separately authorized study, with a new request ID. The top-level IDs in the response refer to the source. A Fork does not grant permission to rerun work stopped by a Notebook refusal; the user must continue that work in the original Session.

Package exports target a new absolute .science path in an existing directory. Keep the operation and correlation IDs. If the bounded wait ends, use the package operation lookup with an original ID; it only reports on a matching operation. An unconfirmed result means the service or delivered file cannot prove what happened. Do not repeat the write automatically. Package operations do not have durable research receipts. For a pending sensitive export, direct the user to the review in Open-Science Desktop on the same profile. After the user responds, query the original operation. The agent cannot approve it.
`

const policies = {
  invalid_request: [
    'agent',
    'Check the arguments against the capability input schema.',
    { action: 'describe_capability' }
  ],
  capability_not_exposed: [
    'agent',
    'This capability is not exposed through this entry point.',
    { action: 'list_capabilities' }
  ],
  daemon_unavailable: [
    'deployment',
    'Open-Science is not running for this profile. Start it or open the App, then check readiness.',
    { action: 'start_service', executable: 'open-science', argv: ['start', '--no-open'] }
  ],
  startup_unconfirmed: [
    'deployment',
    'Could not confirm standalone startup. Check the service status and startup log.',
    { action: 'service_status', executable: 'open-science', argv: ['status', '--json'] }
  ],
  unsupported_capability: [
    'deployment',
    'The service does not support this operation. Update the service and check its capabilities.',
    { action: 'update_service' }
  ],
  access_denied: [
    'deployment',
    'Access denied. Check the selected profile and service authentication.',
    { action: 'check_profile' }
  ],
  runtime_unavailable: [
    'deployment',
    'The service could not prepare the selected runtime. Check its installation options and network in Open-Science, then recheck setup.',
    { action: 'get_setup_status' }
  ],
  configuration_conflict: [
    'user',
    'The current runtime, provider, or model conflicts with this setup request. Recheck this profile before deciding whether to change it.',
    { action: 'get_setup_status' }
  ],
  credential_invalid: [
    'user',
    'The chosen provider credential is missing, unreadable, or invalid. Check the credential reference or environment variable for this profile.',
    { action: 'list_providers' }
  ],
  provider_credential_missing: [
    'user',
    'The specified environment variable is not available to this CLI or MCP process. Make it available to this host for the same profile or select an existing credential reference. Never put a key in a tool argument.',
    { action: 'list_providers' }
  ],
  provider_validation_failed: [
    'agent',
    'The selected provider and model did not pass validation. Check the reported category and recheck provider options before retrying.',
    { action: 'list_providers' }
  ],
  bootstrap_failed: [
    'service',
    'Open-Science could not complete setup. Check current setup before repeating the operation.',
    { action: 'get_setup_status' }
  ],
  notebook_setup_failed: [
    'service',
    'Open-Science could not prepare the requested Notebook language. Recheck setup and inspect the service log before repeating it.',
    { action: 'get_setup_status' }
  ],
  notebook_environment_operation_conflict: [
    'agent',
    'This operation ID belongs to another request, or this language already has a setup operation in progress. Check setup before requesting another write.',
    { action: 'get_setup_status' }
  ],
  notebook_continuation_expired: [
    'agent',
    'This Notebook stop is no longer current. Inspect the original Run and ask the user before starting any new work.',
    { action: 'get_run' }
  ],
  browser_unavailable: [
    'agent',
    'Could not launch the local browser. Use Open-Science Web or Settings for this profile from a host with a browser.',
    { action: 'get_setup_status' }
  ],
  state_conflict: [
    'agent',
    'The operation conflicts with current state. Read the latest state and revision before retrying.',
    { action: 'inspect_state' }
  ],
  'stale-plan': [
    'agent',
    'The reviewed Plan is no longer active. Read the current interaction before asking the user again.',
    { action: 'list_interactions' }
  ],
  'revision-conflict': [
    'agent',
    'The Plan revision changed. Read the current revision and present it before responding.',
    { action: 'get_interaction' }
  ],
  'approval-already-decided': [
    'agent',
    'The Plan already has a different response. Query the original interaction before continuing.',
    { action: 'get_interaction' }
  ],
  'interaction-mismatch': [
    'agent',
    'The interaction is no longer valid in this scope. Check the original task and active branch.',
    { action: 'list_interactions' }
  ],
  interaction_not_found: [
    'agent',
    'This interaction does not belong to the supplied Run or Session. Check the original scope.',
    { action: 'list_interactions' }
  ],
  question_already_answered: [
    'agent',
    'The question already has a different recorded answer. Read that interaction before continuing.',
    { action: 'get_interaction' }
  ],
  interaction_revision_conflict: [
    'agent',
    'Read the current interaction and active branch before responding again.',
    { action: 'get_interaction' }
  ],
  project_not_found: [
    'agent',
    'Project not found. Refresh list_projects.',
    { action: 'list_projects' }
  ],
  project_conflict: [
    'agent',
    'The Project changed. Read its current updatedAt and review the change before updating again.',
    { action: 'list_projects' }
  ],
  session_not_found: [
    'agent',
    'Session not found. Refresh list_sessions.',
    { action: 'list_sessions' }
  ],
  session_project_mismatch: [
    'agent',
    'The Session does not belong to the supplied Project. Check its Project ID before continuing.',
    { action: 'list_sessions' }
  ],
  session_read_only: [
    'user',
    'Imported history is read-only. Review the Session and ask the user before creating a writable Fork.',
    { action: 'get_session' }
  ],
  session_revision_conflict: [
    'agent',
    'The Session configuration changed. Read the current revision before updating again.',
    { action: 'get_session_configuration' }
  ],
  invalid_configuration: [
    'agent',
    'The service rejected these settings. Check the configured providers, models, and Compute Hosts.',
    { action: 'inspect_state' }
  ],
  run_not_found: [
    'agent',
    'Run not found. Check the original Run ID.',
    { action: 'inspect_state' }
  ],
  submission_not_found: [
    'agent',
    'No receipt was found for this request ID. Check the original ID and profile before doing anything else.',
    { action: 'get_submission' }
  ],
  submission_conflict: [
    'agent',
    'This request ID belongs to a different effective request. Inspect its receipt before continuing.',
    { action: 'get_submission' }
  ],
  submission_unavailable: [
    'service',
    'The receipt store is unavailable. Check the original request after the service becomes available.',
    { action: 'get_submission' }
  ],
  artifact_not_found: [
    'agent',
    'Artifact not found. Refresh list_artifacts.',
    { action: 'list_artifacts' }
  ],
  literature_item_not_found: [
    'agent',
    'Literature item not found. Refresh search_literature.',
    { action: 'search_literature' }
  ],
  literature_project_link_failed: [
    'agent',
    'Records were imported but not linked to the Project. Link the returned itemIds without importing again.',
    { action: 'update_project_literature' }
  ],
  timeout: [
    'service',
    'The request timed out. Check the original operation state before repeating any write.',
    { action: 'inspect_state' }
  ],
  request_failed: [
    'service',
    'The operation failed. Check service readiness and the original state before repeating any write.',
    { action: 'doctor' }
  ]
}

// Only adapter code constructs this error with user-facing copy. SDK messages are never forwarded.
export class AgentError extends Error {
  constructor(code, overrides = {}) {
    const [owner, message, next] = Object.hasOwn(policies, code)
      ? policies[code]
      : policies.request_failed
    super(overrides.message ?? message)
    this.name = 'AgentError'
    this.details = {
      code,
      message,
      retryable: false,
      requiresUser: false,
      owner,
      next: [next],
      ...overrides
    }
  }
}

const safeId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)
const requestReferences = (error, args) => {
  const references = {}
  for (const key of [
    'requestId',
    'runId',
    'sessionId',
    'projectId',
    'interactionId',
    'operationId',
    'correlationId'
  ]) {
    const value = [error?.[key], args?.[key]].find((id) => safeId.safeParse(id).success)
    if (value) references[key] = value
  }
  return references
}
export const agentErrorDetails = (
  error,
  { capability, configRoot, readOnly, connected, args = {} } = {}
) => {
  if (error instanceof AgentError)
    return { ...error.details, ...requestReferences(error.details, args) }
  const status = error?.status
  const known = Object.hasOwn(policies, error?.code)
  const code =
    status === 401 || status === 403
      ? 'access_denied'
      : error?.code === 'request_timeout' || error?.name === 'TimeoutError'
        ? 'timeout'
        : status === 404 &&
            (error?.code === 'not_found' ||
              [
                'doctor',
                'get_setup_status',
                'select_runtime',
                'prepare_runtime',
                'configure_provider',
                'prepare_notebook_environment',
                'repair_notebook_environment',
                'get_notebook_environment_operation',
                'cancel_notebook_environment_operation'
              ].includes(capability))
          ? 'unsupported_capability'
          : known && !(status >= 500 && error.code === 'daemon_unavailable')
            ? error.code
            : status === 409
              ? 'state_conflict'
              : status === 400
                ? 'invalid_request'
                : 'request_failed'
  const details = new AgentError(code).details
  if (
    [
      'daemon_unavailable',
      'startup_unconfirmed',
      'access_denied',
      'unsupported_capability',
      'runtime_unavailable',
      'configuration_conflict'
    ].includes(code)
  ) {
    details.requiresUser = true
  }
  if (code === 'session_read_only') details.requiresUser = true
  details.retryable = readOnly === true && code === 'timeout'
  if (configRoot && ['daemon_unavailable', 'startup_unconfirmed'].includes(code)) {
    const [next] = details.next
    details.next = [{ ...next, argv: [...next.argv, '--profile', configRoot] }]
  }
  Object.assign(details, requestReferences(error, args))
  if (code === 'literature_project_link_failed' && Array.isArray(error.itemIds)) {
    details.itemIds = error.itemIds.filter((id) => safeId.safeParse(id).success)
  }
  if (['unconfirmed', 'submission-unconfirmed'].includes(error?.completionStatus)) {
    details.completionStatus = error.completionStatus
    details.retryable = false
  } else if (
    connected &&
    !readOnly &&
    ['timeout', 'request_failed'].includes(code) &&
    (status === undefined || status >= 500)
  ) {
    details.completionStatus = 'unconfirmed'
  }
  if (
    details.requestId &&
    (details.completionStatus === 'submission-unconfirmed' ||
      ['submission_conflict', 'submission_unavailable', 'submission_not_found'].includes(code))
  ) {
    details.next = [{ action: 'get_submission', requestId: details.requestId }]
    if (
      details.completionStatus === 'submission-unconfirmed' &&
      code !== 'submission_unavailable'
    ) {
      details.message =
        'Submission unconfirmed. Query the original request ID before submitting anything again.'
    }
  }
  if (code === 'timeout' && ['wait_submission', 'wait_run'].includes(capability)) {
    details.timeoutMs = args.timeoutMs
    details.next =
      capability === 'wait_submission'
        ? [{ action: 'get_submission', requestId: details.requestId }]
        : [{ action: 'get_run', runId: details.runId }]
    details.message =
      'The observation timed out. Query the original operation; it was not cancelled.'
  }
  if (capability === 'respond_plan' && details.completionStatus === 'unconfirmed') {
    details.next = [
      {
        action: 'get_interaction',
        ...(details.projectId ? { projectId: details.projectId } : {}),
        ...(details.sessionId ? { sessionId: details.sessionId } : {}),
        ...(safeId.safeParse(args.artifactVersionId).success
          ? { interactionId: `plan:${args.artifactVersionId}` }
          : {})
      }
    ]
  }
  if (
    details.operationId &&
    ['python', 'r'].includes(args.language) &&
    ['timeout', 'request_failed'].includes(code) &&
    [
      'prepare_notebook_environment',
      'repair_notebook_environment',
      'cancel_notebook_environment_operation'
    ].includes(capability)
  ) {
    details.next = [
      {
        action: 'get_notebook_environment_operation',
        arguments: { language: args.language, operationId: details.operationId }
      }
    ]
  }
  return details
}

const groups = ['discovery', 'setup', 'research', 'delivery']
const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
}

const localDiscovery = (name, description, inputSchema, handler) => ({
  name,
  group: 'discovery',
  description,
  inputSchema,
  annotations: readOnly,
  exposure: { cli: true, mcp: true },
  local: true,
  handler
})

const describe = ({ name, group, description, annotations, exposure }) => ({
  name,
  group,
  description,
  annotations,
  exposure: { cli: exposure?.cli === true, mcp: exposure?.mcp === true }
})

// Use the input representation so defaults are visible and callers see which fields may be omitted.
export const agentInputSchema = ({ inputSchema }) => z.toJSONSchema(inputSchema, { io: 'input' })

const isExposed = (entry, exposure) =>
  exposure
    ? entry.exposure?.[exposure] === true
    : entry.exposure?.cli === true || entry.exposure?.mcp === true

export const listAgentCapabilities = (exposure) =>
  [...capabilities.values()].filter((entry) => isExposed(entry, exposure))

const getCapability = (name, exposure) => {
  const entry = capabilities.get(name)
  if (!entry || !isExposed(entry, exposure)) {
    throw new AgentError('capability_not_exposed')
  }
  return entry
}

async function catalog({ group, checkService }, { probeService }) {
  const selected = listAgentCapabilities().filter((entry) => !group || entry.group === group)
  const { support, ...service } = checkService
    ? await probeService(selected)
    : { status: 'unchecked' }
  const catalogGroups = {}
  for (const current of group ? [group] : groups) {
    catalogGroups[current] = selected
      .filter((entry) => entry.group === current)
      .map((entry) => ({
        ...describe(entry),
        serviceSupport: entry.local
          ? 'not_required'
          : service.status === 'unavailable'
            ? 'unavailable'
            : (support?.[entry.name] ?? 'unknown')
      }))
  }
  return { groups: catalogGroups, service }
}

const readinessStatus = (value) =>
  ['ready', 'missing', 'not_ready'].includes(value) ? value : 'unconfirmed'
const frameworks = ['open-science-agent', 'claude-code', 'opencode', 'codex', 'codebuddy', 'pi']
const providerReasons = [
  'credential_invalid',
  'network',
  'model-not-found',
  'bad-url',
  'timeout',
  'incompatible',
  'server-error',
  'unknown'
]
const setupCodes = [
  'runtime_missing',
  'runtime_not_ready',
  'provider_missing',
  'provider_not_ready'
]

async function doctor({ language }, { getClient, configRoot, signal }) {
  const client = await getClient()
  const profile = client.configRoot ?? configRoot
  const [report, deliveryDirectory] = await Promise.all([
    client.doctor({ signal }),
    inspectAgentDeliveryDirectory(profile)
  ])
  const notebook = projectAgentNotebookReadiness(report?.checks?.notebook, profile, language)
  const runtime = report?.checks?.runtime
  const provider = report?.checks?.provider
  const selectedFramework = frameworks.includes(runtime?.selectedFramework)
    ? runtime.selectedFramework
    : runtime?.selectedFramework === null
      ? null
      : undefined
  const agent =
    report?.ready === true && runtime?.status === 'ready' && provider?.status === 'ready'
      ? 'ready'
      : report?.ready === false
        ? 'blocked'
        : 'unconfirmed'
  return {
    ...(profile ? { profile } : {}),
    readiness: { service: 'ready', agent, notebook: notebook.status },
    checks: {
      runtime: {
        status: readinessStatus(runtime?.status),
        ...(frameworks.includes(runtime?.framework) ? { framework: runtime.framework } : {}),
        ...(selectedFramework !== undefined ? { selectedFramework } : {})
      },
      provider: {
        status: readinessStatus(provider?.status),
        ...(providerReasons.includes(provider?.reason) ? { reason: provider.reason } : {})
      },
      notebook: notebook.checks,
      deliveryDirectory
    },
    next: [
      ...(selectedFramework === null && provider?.status === 'missing'
        ? [
            {
              code: 'runtime_selection_required',
              action: 'choose_runtime',
              owner: 'user',
              requiresUser: true,
              message:
                'No Agent runtime has been selected. List the available runtimes and ask which runtime and provider to use.',
              options: { capability: 'list_runtimes' },
              providerDiscovery: { capability: 'list_providers' },
              web: { capability: 'open_setup' },
              verify: { capability: 'get_setup_status', ...(profile ? { profile } : {}) }
            }
          ]
        : Array.isArray(report?.next)
          ? report.next
              .filter((item) => setupCodes.includes(item?.code))
              .map((item) =>
                setupAction(
                  item,
                  profile,
                  selectedFramework,
                  provider?.keylessKiloAvailable === true
                )
              )
          : []),
      ...notebook.next,
      ...readinessActions([deliveryDirectory], profile)
    ]
  }
}

const DEFAULT_RUNTIME_TIMEOUT_MS = 600_000
const frameworkInput = z.enum(frameworks).describe('Agent runtime from list_runtimes; no default.')
const languageInput = z
  .enum(['python', 'r'])
  .describe('Notebook language required for the work; no default.')
const setupTimeout = z
  .number()
  .int()
  .min(1)
  .max(DEFAULT_RUNTIME_TIMEOUT_MS)
  .default(DEFAULT_RUNTIME_TIMEOUT_MS)
const setupWrite = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
}
async function setupClient({ getClient, signal }, marker) {
  const client = await getClient()
  const health = await client.health({ signal })
  if (!health?.taskCapabilities?.includes(marker))
    throw new AgentError('unsupported_capability', { requiresUser: true })
  return client
}

async function bootstrapSetup(request, { timeoutMs }, context) {
  const { getClient, signal } = context
  const client = await setupClient({ getClient, signal }, 'agent-setup')
  const result = await client.bootstrap(request, { signal, timeoutMs })
  if (!result?.ok) {
    const code = ['runtime_unavailable', 'configuration_conflict', 'invalid_request'].includes(
      result?.code
    )
      ? result.code
      : 'bootstrap_failed'
    throw new AgentError(code, { requiresUser: code === 'configuration_conflict' })
  }
  return { ...(await doctor({}, context)), timeoutMs }
}

async function providerSetup(request, context) {
  const client = await setupClient(context, 'provider-setup')
  const result = await client.bootstrap(request, { signal: context.signal, timeoutMs: 60_000 })
  const data =
    request.action === 'provider-options' ? result?.providerOptions : result?.providerSetup
  if (result?.ok && data) return data
  const code = [
    'configuration_conflict',
    'credential_invalid',
    'invalid_request',
    'provider_validation_failed'
  ].includes(result?.code)
    ? result.code
    : 'bootstrap_failed'
  const category = ['auth', ...providerReasons].includes(result?.category)
    ? result.category
    : undefined
  const needsCredential = code === 'credential_invalid' || category === 'auth'
  throw new AgentError(code, {
    requiresUser: needsCredential || code === 'configuration_conflict',
    ...(needsCredential ? { owner: 'user' } : {}),
    ...(code === 'configuration_conflict' ? { next: [{ action: 'list_providers' }] } : {}),
    ...(category ? { category } : {})
  })
}

const notebookOperationTarget = {
  language: languageInput,
  operationId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .describe('A unique operation ID you generate and retain before submission, such as a UUID.')
}
const notebookOperationTimeout = z.number().int().min(0).max(30_000).default(1_000)
const notebookSetupSupport = 'notebook-setup-operations'

function notebookOperationResult(operation, target, timeoutMs) {
  return {
    operation,
    ...(timeoutMs === undefined
      ? {}
      : { timeoutMs, timedOut: timeoutMs > 0 && operation.status === 'preparing' }),
    next: [
      operation.status === 'preparing'
        ? { action: 'get_notebook_environment_operation', arguments: target }
        : { action: 'get_setup_status', arguments: { language: target.language } }
    ]
  }
}

async function startNotebookOperation(action, { language, operationId, timeoutMs }, context) {
  const client = await setupClient(context, notebookSetupSupport)
  const { signal } = context
  const target = { language, operationId }
  let operation = await client.startNotebookEnvironmentOperation({ ...target, action }, { signal })
  const deadline = performance.now() + timeoutMs
  while (operation.status === 'preparing' && performance.now() < deadline) {
    await delay(Math.min(250, Math.max(1, deadline - performance.now())), undefined, { signal })
    const remaining = deadline - performance.now()
    if (remaining <= 0) break
    try {
      operation = await client.getNotebookEnvironmentOperation(target, {
        signal,
        timeoutMs: remaining
      })
    } catch (error) {
      if (error?.code !== 'timeout') throw error
      break
    }
  }
  return notebookOperationResult(operation, target, timeoutMs)
}

const setupStatus = {
  name: 'doctor',
  group: 'setup',
  description:
    'Read Agent and Notebook readiness for this profile. Without a language, report Python and R without assuming which one is needed. A check does not install or change setup.',
  inputSchema: z.strictObject({ language: languageInput.optional() }),
  annotations: readOnly,
  exposure: { cli: true, mcp: true },
  serviceCapability: 'doctor',
  checkSupport: async (client, signal) =>
    typeof (await client.doctor({ signal }))?.ready === 'boolean',
  probeOnly: true,
  handler: doctor
}

const definitions = [
  localDiscovery(
    'list_capabilities',
    'List exposed capabilities by group. Optionally check the selected service for advertised support.',
    z.strictObject({
      group: z.enum(groups).describe('Omit to list every capability group.').optional(),
      checkService: z
        .boolean()
        .describe('Probe the selected service without starting it.')
        .default(false)
    }),
    catalog
  ),
  localDiscovery(
    'describe_capability',
    'Read the input schema, defaults, effects, and exposure for a registered capability.',
    z.strictObject({ name: z.string().min(1).describe('Capability name from list_capabilities.') }),
    ({ name }) => {
      const entry = getCapability(name)
      return { ...describe(entry), inputSchema: agentInputSchema(entry) }
    }
  ),
  localDiscovery(
    'get_agent_guide',
    'Read the local guide, including setup, human actions, research recovery and file delivery.',
    z.strictObject({}),
    () => agentGuide
  ),
  setupStatus,
  { ...setupStatus, name: 'get_setup_status' },
  {
    name: 'select_runtime',
    group: 'setup',
    description:
      'Select the named Agent runtime after the user chooses it. Changes this profile’s active runtime; does not install it or select a model provider.',
    inputSchema: z.strictObject({ framework: frameworkInput }),
    annotations: { ...setupWrite, openWorldHint: false },
    exposure: { cli: true, mcp: true },
    serviceCapability: 'agent-setup',
    handler: async ({ framework }, context) => {
      const client = await setupClient(context, 'agent-setup')
      await client.updateAgentRouting({ framework }, { signal: context.signal })
      return doctor({}, context)
    }
  },
  {
    name: 'prepare_runtime',
    group: 'setup',
    description:
      'Check or install the named Agent runtime using the managed installer. Does not change the selected runtime or provider. Call only for the runtime the user chose.',
    inputSchema: z.strictObject({ framework: frameworkInput, timeoutMs: setupTimeout }),
    annotations: setupWrite,
    exposure: { cli: true, mcp: true },
    serviceCapability: 'agent-setup',
    handler: (args, context) =>
      bootstrapSetup({ action: 'agent-runtime', framework: args.framework }, args, context)
  },
  {
    name: 'configure_provider',
    group: 'setup',
    description:
      'Set up and check the offered keyless Kilo Gateway free route after the user chooses it. Select the requested framework first. This cannot replace an active provider or accept a credential. For ordinary API providers, use list_providers and save_api_provider.',
    inputSchema: z.strictObject({
      provider: z.literal('kilo-free'),
      framework: frameworkInput,
      timeoutMs: setupTimeout
    }),
    annotations: setupWrite,
    exposure: { cli: true, mcp: true },
    serviceCapability: 'agent-setup',
    handler: (args, context) =>
      bootstrapSetup({ action: 'kilo-free', framework: args.framework }, args, context)
  },
  {
    name: 'list_providers',
    group: 'setup',
    description:
      'Read configured providers, bundled API options, model compatibility, and the current model selection. Omit framework to check the current effective runtime. Does not sign in, select, or install anything.',
    inputSchema: z.strictObject({ framework: frameworkInput.optional() }),
    annotations: readOnly,
    exposure: { cli: true, mcp: true },
    serviceCapability: 'provider-setup',
    handler: (args, context) => providerSetup({ action: 'provider-options', ...args }, context)
  },
  {
    name: 'save_api_provider',
    group: 'setup',
    description:
      'Validate and save a new API provider for the selected framework and exact model, without activating it. Official providers take a vendorId and optional region; custom providers take a baseUrl and protocol. Supply only a user-chosen apiKeyEnv or credentialRef when a key is required. Never pass a credential value.',
    inputSchema: z.strictObject({
      providerType: z.enum(['official', 'custom']),
      framework: frameworkInput,
      model: z.string().trim().min(1).max(512),
      name: z.string().trim().min(1).max(128).optional(),
      vendorId: safeId.optional(),
      region: safeId.optional(),
      baseUrl: z.string().trim().min(1).max(2048).optional(),
      protocol: z.enum(['messages', 'chat-completions', 'responses']).optional(),
      apiKeyEnv: z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
        .optional(),
      credentialRef: safeId.optional()
    }),
    annotations: { ...setupWrite, idempotentHint: false },
    exposure: { cli: true, mcp: true },
    serviceCapability: 'provider-setup',
    handler: ({ apiKeyEnv, ...args }, context) => {
      if (
        (apiKeyEnv && args.credentialRef) ||
        (args.providerType === 'official'
          ? !args.vendorId || args.baseUrl || args.protocol
          : !args.baseUrl || !args.protocol || args.vendorId || args.region)
      )
        throw new AgentError('invalid_request')
      const key = apiKeyEnv ? process.env[apiKeyEnv]?.trim() : undefined
      if (apiKeyEnv && !key)
        throw new AgentError('provider_credential_missing', { requiresUser: true })
      if (key && Buffer.byteLength(key, 'utf8') > 8192)
        throw new AgentError('credential_invalid', { requiresUser: true })
      return providerSetup({ action: 'provider-save', ...args, ...(key ? { key } : {}) }, context)
    }
  },
  {
    name: 'activate_provider',
    group: 'setup',
    description:
      'Validate and activate an explicitly chosen saved API provider and model. Copy the active provider and model from list_providers, including nulls for an empty selection. A different or changed selection is a conflict. For subscription authentication, use the user sign-in handoff.',
    inputSchema: z.strictObject({
      framework: frameworkInput,
      providerId: safeId,
      model: z.string().trim().min(1).max(512),
      expectedActiveProviderId: safeId.nullable(),
      expectedActiveModel: z.string().trim().min(1).max(512).nullable()
    }),
    annotations: { ...setupWrite, destructiveHint: true },
    exposure: { cli: true, mcp: true },
    serviceCapability: 'provider-setup',
    handler: (args, context) => providerSetup({ action: 'provider-activate', ...args }, context)
  },
  {
    name: 'prepare_notebook_environment',
    group: 'setup',
    description:
      'Prepare the explicitly requested managed Python or R environment. Retain a new operation ID before calling. The bounded wait leaves work running; query the original operation by ID after a timeout or disconnect. Setup does not authorize or run a Notebook.',
    inputSchema: z.strictObject({
      ...notebookOperationTarget,
      timeoutMs: notebookOperationTimeout
    }),
    annotations: setupWrite,
    exposure: { cli: true, mcp: true },
    serviceCapability: notebookSetupSupport,
    handler: (args, context) => startNotebookOperation('prepare', args, context)
  },
  {
    name: 'repair_notebook_environment',
    group: 'setup',
    description:
      'Rebuild the current app-managed default environment for the selected language when authorized by the user. It can replace that environment and interrupt its kernels. Use a new operation ID and query that ID afterward.',
    inputSchema: z.strictObject({
      ...notebookOperationTarget,
      timeoutMs: notebookOperationTimeout
    }),
    annotations: { ...setupWrite, destructiveHint: true },
    exposure: { cli: true, mcp: true },
    serviceCapability: notebookSetupSupport,
    handler: (args, context) => startNotebookOperation('repair', args, context)
  },
  {
    name: 'get_notebook_environment_operation',
    group: 'setup',
    description:
      'Read setup progress and the outcome for the original language and operation ID. Unconfirmed means the service cannot establish the outcome; recheck language readiness before any new write.',
    inputSchema: z.strictObject(notebookOperationTarget),
    annotations: readOnly,
    exposure: { cli: true, mcp: true },
    serviceCapability: notebookSetupSupport,
    handler: async (target, context) => {
      const client = await setupClient(context, notebookSetupSupport)
      return notebookOperationResult(
        await client.getNotebookEnvironmentOperation(target, { signal: context.signal }),
        target
      )
    }
  },
  {
    name: 'cancel_notebook_environment_operation',
    group: 'setup',
    description:
      'Request cancellation of this exact managed setup operation. Observe its final result; repair may already have reached the point where it must finish.',
    inputSchema: z.strictObject(notebookOperationTarget),
    annotations: { ...setupWrite, openWorldHint: false },
    exposure: { cli: true, mcp: true },
    serviceCapability: notebookSetupSupport,
    handler: async (target, context) => {
      const client = await setupClient(context, notebookSetupSupport)
      return notebookOperationResult(
        await client.cancelNotebookEnvironmentOperation(target, { signal: context.signal }),
        target
      )
    }
  },
  {
    name: 'open_setup',
    group: 'setup',
    description:
      'Open the authenticated local Open-Science Web app for this profile in the default browser. Set section to notebook to open the Python and R environment settings. The private URL is not returned. The user completes sign-in and approval prompts.',
    inputSchema: z.strictObject({ section: z.literal('notebook').optional() }),
    annotations: { ...setupWrite, idempotentHint: false },
    exposure: { cli: true, mcp: true },
    serviceCapability: 'doctor',
    handler: async ({ section }, { getClient }) => {
      const client = await getClient()
      const url = new URL(client.baseUrl)
      if (!client.configRoot || url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
        throw new AgentError('browser_unavailable')
      url.searchParams.set('token', client.token)
      if (section === 'notebook') url.searchParams.set('settings', 'runtimes')
      if (!(await openBrowser(url.href))) throw new AgentError('browser_unavailable')
      return { profile: client.configRoot, status: 'launch_requested' }
    }
  },
  ...existingMcpCapabilities,
  ...artifactCapabilities,
  ...getAgentPackageCapabilities(AgentError)
]
const capabilities = new Map(definitions.map((entry) => [entry.name, entry]))

export const invokeAgentCapability = async (
  name,
  input,
  { exposure, configRoot, signal, connect = connectToOpenScience, probe = connect }
) => {
  const entry = getCapability(name, exposure)
  const args = entry.inputSchema.safeParse(input)
  if (!args.success) throw new AgentError('invalid_request', requestReferences(undefined, input))

  let client
  const context = {
    exposure,
    configRoot,
    signal,
    getClient: async (requestSignal = signal) => {
      requestSignal?.throwIfAborted()
      client ??= await (entry.probeOnly ? probe : connect)({ configRoot, signal: requestSignal })
      requestSignal?.throwIfAborted()
      return client
    },
    probeService: async (entries) => {
      const timeout = AbortSignal.timeout(5_000)
      const probeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
      try {
        const service = await probe({ configRoot, signal: probeSignal })
        const health = await service.health({ signal: probeSignal })
        const markers = Array.isArray(health?.taskCapabilities)
          ? health.taskCapabilities
          : undefined
        const support = {}
        for (const entry of entries) {
          if (entry.serviceCapability && markers?.includes(entry.serviceCapability)) {
            support[entry.name] = 'supported'
          } else if (entry.checkSupport) {
            // Legacy services may implement a read endpoint without advertising its capability.
            try {
              if (await entry.checkSupport(service, probeSignal)) support[entry.name] = 'supported'
            } catch (error) {
              if (error?.status === 404) support[entry.name] = 'unsupported'
            }
          } else if (entry.serviceCapability && markers) {
            support[entry.name] = 'unsupported'
          }
        }
        return { status: 'reachable', support }
      } catch (error) {
        return {
          status: 'unavailable',
          error: agentErrorDetails(error, { configRoot, readOnly: true })
        }
      }
    }
  }
  try {
    return await entry.handler(args.data, context)
  } catch (error) {
    throw new AgentError(
      'request_failed',
      agentErrorDetails(error, {
        capability: name,
        configRoot,
        readOnly: entry.annotations?.readOnlyHint,
        connected: Boolean(client),
        args: args.data
      })
    )
  }
}
