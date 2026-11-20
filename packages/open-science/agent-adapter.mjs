/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { z } from 'zod'
import { artifactCapabilities } from './agent-artifacts.mjs'
import { existingMcpCapabilities } from './agent-capabilities.mjs'
import { inspectAgentDeliveryDirectory } from './agent-delivery-directory.mjs'
import { projectAgentNotebookReadiness, readinessActions } from './agent-notebook-readiness.mjs'
import { getAgentPackageCapabilities } from './agent-package-capabilities.mjs'
import { setupAction } from './agent-setup-action.mjs'
import { connectToOpenScience } from './index.mjs'

export const agentGuideUri = 'openscience://agent/guide'
export const agentGuide = `# Open-Science for external agents

Run the agent, the Open-Science service, and the MCP process on the same machine with access to the input and delivery files. A remote service path is not a file the agent can read.

Install Open-Science with the application's installer or npm package. Start the selected profile with \`open-science start --no-open\`, or connect a local stdio MCP client to \`open-science mcp\` to start or reuse the service.

Use the capability catalog and detail schemas to find the operations the installed adapter exposes. Check service support and call doctor for the same profile. Base Agent readiness does not prove that a Notebook can run, has run, or produced files.

For provider setup, relay the exact executable and argv from the setup action, including the selected profile. Wait for the user to sign in and then recheck that profile. Do not ask for or print credentials.

Use the user's research instructions and choose an explicit Project. Omit the working directory to use the Project default for a new Session, or the existing Session directory when continuing. The Agent delivery directory is for downloads and may not exist before the first delivery. Generate and keep a request ID before sending. If the response is lost, query the original receipt in the same profile. Waiting only observes work; it does not cancel it. Use a new ID only for a new research turn. Leave provider credentials, Notebook continuation, and sensitive export confirmation to the user in Open-Science.

Read the Run's Notebook execution separately from its outer status. When execution is waiting_for_user, follow its next action. For review_notebook_code_in_app, ask the user to decide the pending review in the original Session and branch in Open-Science on the same profile. Recheck the same Run after the user responds. The agent cannot make the decision or submit a replacement Run.
For review_notebook_runtime_in_app, ask the user to respond to Confirm Notebook kernel and environment in the original Session and branch in Open-Science on the same profile. This decision can be pending before a Notebook Run exists. Recheck the same Run after the user responds; do not make the decision or submit a replacement Run.

For continue_notebook_in_app, keep the refusal ID. Once the cause is resolved, ask the user to open the original Session and branch in the Open-Science desktop app connected to this service and choose Continue Notebook work in Compute. Web can show the handoff but cannot continue the stopped intent. Do not resubmit, change execution context, or delegate stopped work. Recheck that same Session and match continuedFromRefusalId to observe the new user-authorized turn.

Notebook working files are not delivered Artifacts. List the Artifacts for the accepted research runId, download the report and results table, and call get_delivery_status with the downloaded paths. Report execution.status and delivery.status separately. Say the handoff is complete only when handoffStatus is complete. If files verify but a Notebook cell failed, report both facts.

If the user attaches a .science package, import it from its absolute local path. Summarize the returned package inventory counts, inspect the read-only Session, and list its published historical Artifacts. Do not run its Notebook or create a writable Fork until the user asks to continue. The package does not authorize the new environment to use any provider or external data source; check readiness and ask the user to configure missing access there.

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
    'The service could not prepare the managed Codex runtime. Check the installation and network in Open-Science Settings, then recheck setup.',
    { action: 'get_setup_status' }
  ],
  configuration_conflict: [
    'user',
    'This profile already selects a different runtime or provider. Review it in Open-Science Settings before preparing Codex.',
    { action: 'get_setup_status' }
  ],
  bootstrap_failed: [
    'service',
    'Open-Science could not prepare the runtime. Check setup status before repeating the operation.',
    { action: 'get_setup_status' }
  ],
  state_conflict: [
    'agent',
    'The operation conflicts with current state. Read the latest state and revision before retrying.',
    { action: 'inspect_state' }
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
  for (const key of ['requestId', 'runId', 'sessionId', 'projectId', 'operationId', 'correlationId']) {
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
              ['doctor', 'get_setup_status', 'prepare_runtime'].includes(capability))
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

async function doctor(_args, { getClient, configRoot, signal }) {
  const client = await getClient()
  const profile = client.configRoot ?? configRoot
  const [report, deliveryDirectory] = await Promise.all([
    client.doctor({ signal }),
    inspectAgentDeliveryDirectory(profile)
  ])
  const notebook = projectAgentNotebookReadiness(report?.checks?.notebook, profile)
  const runtime = report?.checks?.runtime
  const provider = report?.checks?.provider
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
        ...(frameworks.includes(runtime?.framework) ? { framework: runtime.framework } : {})
      },
      provider: {
        status: readinessStatus(provider?.status),
        ...(providerReasons.includes(provider?.reason) ? { reason: provider.reason } : {})
      },
      notebook: notebook.checks,
      deliveryDirectory
    },
    next: [
      ...(Array.isArray(report?.next)
        ? report.next
            .filter((item) => setupCodes.includes(item?.code))
            .map((item) => setupAction(item, profile))
        : []),
      ...notebook.next,
      ...readinessActions([deliveryDirectory], profile)
    ]
  }
}

const DEFAULT_RUNTIME_TIMEOUT_MS = 600_000
async function prepareRuntime({ timeoutMs }, context) {
  const { getClient, signal } = context
  const client = await getClient()
  const health = await client.health({ signal })
  if (!health?.taskCapabilities?.includes('runtime-bootstrap')) {
    throw new AgentError('unsupported_capability', { requiresUser: true })
  }
  const result = await client.bootstrap({ action: 'runtime' }, { signal, timeoutMs })
  if (!result?.ok) {
    const code = ['runtime_unavailable', 'configuration_conflict'].includes(result?.code)
      ? result.code
      : 'bootstrap_failed'
    throw new AgentError(code, { requiresUser: code !== 'bootstrap_failed' })
  }
  return { ...(await doctor({}, context)), timeoutMs }
}

const setupStatus = {
  name: 'doctor',
  group: 'setup',
  description:
    'Read Agent and Notebook readiness and the default local delivery directory. Actions identify who should handle a blocker and how to recheck this profile.',
  inputSchema: z.strictObject({}),
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
    name: 'prepare_runtime',
    group: 'setup',
    description:
      'Prepare the managed Codex runtime without model credentials, then recheck setup for this profile.',
    inputSchema: z.strictObject({
      timeoutMs: z
        .number()
        .int()
        .min(1)
        .max(DEFAULT_RUNTIME_TIMEOUT_MS)
        .default(DEFAULT_RUNTIME_TIMEOUT_MS)
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    exposure: { cli: true, mcp: true },
    serviceCapability: 'runtime-bootstrap',
    handler: prepareRuntime
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
