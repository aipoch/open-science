/* eslint-disable @typescript-eslint/explicit-function-return-type */

import * as acp from '@agentclientprotocol/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import JSZip from 'jszip'
import { appendFile, chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

const VERSION = '1.0.0'
const PERMISSION_PROMPT = 'Request fixture permission.'
const SKILL_PERMISSION_PROMPT = 'Request fixture skill permission.'
const MEMORY_RECALL_PROMPT = 'Verify automatic memory recall.'
const MEMORY_RECALL_ENTRY = 'Keep every response concise and welcoming.'
const PROVIDER_BRIDGE_PROMPT = 'Verify the provider bridge.'
const NOTEBOOK_LIFECYCLE_PROMPT = 'Verify the notebook lifecycle.'
const PERFORMANCE_NOTEBOOK_LIFECYCLE_PROMPT = 'Profile the notebook lifecycle.'
const ARTIFACT_PROVENANCE_PROMPT = 'Create a provenance artifact.'
const PREVIEW_CONTEXT_MENU_ARTIFACTS_PROMPT = 'Create preview context menu artifacts.'
const PREVIEW_CONTEXT_MENU_DOCX_BASE64 =
  'UEsDBAoAAAAIABQ7HF15bjPX6AAAAK0BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH1QyU7DMBD9FWuuKHHggBCK0wPLETiUDxjZk8SqN3nc0v49Tlt6QIXjzFv1+tXeO7GjzDYGBbdtB4KCjsaGScHn+rV5AMEFg0EXAyk4EMNq6NeHRCyqNrCCuZT0KCXrmTxyGxOFiowxeyz1zJNMqDc4kbzrunupYygUSlMWDxj6Zxpx64p42df3qUcmxyCeTsQlSwGm5KzGUnG5C+ZXSnNOaKvyyOHZJr6pBJBXExbk74Cz7r0Ok60h8YG5vKGvLPkVs5Em6q2vyvZ/mys94zhaTRf94pZy1MRcF/euvSAebfjpL49zD99QSwMECgAAAAAAFDscXQAAAAAAAAAAAAAAAAYAAABfcmVscy9QSwMECgAAAAgAFDscXZv9N+qtAAAAKQEAAAsAAABfcmVscy8ucmVsc43POw7CMAwG4KtE3mlaBoRQ0y4IqSsqB7ASN61oHkrCo7cnAwNFDIy2f3+W6/ZpZnanECdnBVRFCYysdGqyWsClP232wGJCq3B2lgQsFKFt6jPNmPJKHCcfWTZsFDCm5A+cRzmSwVg4TzZPBhcMplwGzT3KK2ri27Lc8fBpwNpknRIQOlUB6xdP/9huGCZJRydvhmz6ceIrkWUMmpKAhwuKq3e7yCzwpuarF5sXUEsDBAoAAAAAABQ7HF0AAAAAAAAAAAAAAAAFAAAAd29yZC9QSwMECgAAAAgAFDscXX5QYG+1AAAA9wAAABEAAAB3b3JkL2RvY3VtZW50LnhtbEWOO27DMAxAryJob+R2KALDdraszdAeQJHoRIBFGiQdO7ev5AxZHsHfI7vTlifzAJZE2NvPQ2MNYKCY8Nbbv9/zx9EaUY/RT4TQ2yeIPQ3d2kYKSwZUUwQo7drbu+rcOifhDtnLgWbA0huJs9eS8s2txHFmCiBS/HlyX03z7bJPaKvySvFZ41zBFTpcGB4JVhMIFTY15eRifsYxBTBj2nRh6FwdrOSd+7pA0Au7vfDyuvfPwz9QSwECFAAKAAAACAAUOxxdeW4z1+gAAACtAQAAEwAAAAAAAAAAAAAAAAAAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAAoAAAAAABQ7HF0AAAAAAAAAAAAAAAAGAAAAAAAAAAAAEAAAABkBAABfcmVscy9QSwECFAAKAAAACAAUOxxdm/036q0AAAApAQAACwAAAAAAAAAAAAAAAAA9AQAAX3JlbHMvLnJlbHNQSwECFAAKAAAAAAAUOxxdAAAAAAAAAAAAAAAABQAAAAAAAAAAABAAAAATAgAAd29yZC9QSwECFAAKAAAACAAUOxxdflBgb7UAAAD3AAAAEQAAAAAAAAAAAAAAAAA2AgAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAUABQAgAQAAGgMAAAAA'

const createPreviewContextMenuXlsxBase64 = async () => {
  const archive = new JSZip()
  archive.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
  )
  archive.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
  )
  archive.file(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Results" sheetId="1" r:id="rId1"/></sheets></workbook>'
  )
  archive.file(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
  )
  archive.file(
    'xl/worksheets/sheet1.xml',
    '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Gene</t></is></c><c r="B1" t="inlineStr"><is><t>log2FC</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>GENE0001</t></is></c><c r="B2"><v>-1.25</v></c></row></sheetData></worksheet>'
  )
  return archive.generateAsync({ type: 'base64', compression: 'DEFLATE' })
}
const DELEGATION_TERMINAL_PROMPT = 'Run the production delegation terminal journey.'
const DELEGATION_ARTIFACT_VERSION_INPUT_PROMPT =
  'Run the production Artifact Version input delegation journey.'
const DELEGATION_BOUNDED_COLLECT_PROMPT = 'Run the production bounded collect journey.'
const DELEGATION_BOUNDED_RECOLLECT_PROMPT = 'Collect the running Subagent in Turn B.'
const DELEGATION_PERMISSION_PROMPT = 'Run the production delegated permission journey.'
const DELEGATION_USER_QUESTION_PROMPT = 'Run the production delegated user question journey.'
const DELEGATION_STOP_PROMPT = 'Run the production delegation Stop journey.'
const DELEGATION_BRANCH_A_PROMPT = 'Start the inactive-branch Stop certification journey.'
const DELEGATION_BRANCH_B_PROMPT = 'Start the active-branch partial Stop certification journey.'
const DELEGATION_UNAVAILABLE_PROMPT = 'Verify unsupported delegation admission.'
const DELEGATION_STRUCTURED_OUTPUT_PROMPT = 'Run the production structured output journey.'
const RELIABLE_MESSAGING_PROMPT = 'Run the production reliable messaging journey.'
const RELIABLE_BRANCH_PARK_PROMPT = 'Start the reliable messaging branch park journey.'
const RELIABLE_BRANCH_WAKE_PROMPT = 'Wake the reliable messaging branch park journey.'
const RELIABLE_FAILURE_PROMPT = 'Start the reliable messaging post-fence failure journey.'
const RELIABLE_FAILURE_OBSERVE_PROMPT = 'Observe the reliable messaging post-fence failure.'
const RELIABLE_FAIRNESS_PROMPT = 'Start the reliable messaging fairness journey.'
const LONG_STREAM_PROMPT = 'Stream the long scroll journey.'
const RUNTIME_RESOURCE_STRESS_PROMPT = 'Run the runtime resource stress journey.'
const QUEUE_GATE_PROMPT = 'Hold the queue until the reveal finishes.'
const TOOL_ORDER_PROMPT = 'Run the ordered slow tool journey.'
const TOOL_LAYOUT_SHIFT_PROMPT = 'Run the tool layout stability journey.'
const TOOL_STATUS_LAYOUT_SHIFT_PROMPT = 'Run the status-bearing layout stability journey.'
const BUFFERED_TEXT_TOOL_LAYOUT_SHIFT_PROMPT =
  'Run the buffered text tool layout stability journey.'
const RELIABLE_FAIRNESS_USER_PROMPT = 'Run the concurrent real user prompt.'
const DELEGATION_INHERITED_SPECIALIST_PROMPT =
  'Run the production inherited Specialist delegation journey.'
const SUBAGENT_MODEL_BATCH_PROMPT = 'Run the Subagent model batch journey.'
const SUBAGENT_MODEL_CONTINUATION_START_PROMPT = 'Start the Subagent model continuation journey.'
const SUBAGENT_MODEL_CONTINUATION_FINISH_PROMPT = 'Finish the Subagent model continuation journey.'
const SUBAGENT_MODEL_UNAVAILABLE_PROMPT = 'Verify the Subagent model unavailable journey.'
const SUBAGENT_MODEL_INHERITED_PROMPT = 'Run the inherited Subagent model journey.'
const SUBAGENT_MODEL_HOLDER_PROMPT = 'Create the global Active model holder.'
const DELEGATED_TERMINAL_TASK = 'Complete the certified delegated terminal fixture.'
const DELEGATED_TERMINAL_NAME = 'Certified delegated terminal'
const DELEGATED_ARTIFACT_VERSION_INPUT_TASK = 'Read the delegated immutable Artifact Version input.'
const DELEGATED_ARTIFACT_VERSION_INPUT_NAME = 'Artifact Version input child'
const DELEGATED_ARTIFACT_VERSION_PRODUCER_NAME = 'Artifact Version producer child'
const DELEGATED_MODEL_CONTINUATION_NAME = 'Model continuation child'
const DELEGATED_INHERITED_SPECIALIST_NAME = 'Inherited specialist terminal'
const DELEGATED_BOUNDED_SLOW_TASK = 'Complete the bounded fixture after a delay.'
const DELEGATED_PERMISSION_TASK = 'Request the delegated fixture permission.'
const DELEGATED_USER_QUESTION_TASK = 'Ask the user for the delegated fixture scope.'
const DELEGATED_USER_QUESTION_NAME = 'Delegated scope researcher'
const DELEGATED_USER_QUESTION_TASK_TWO = 'Ask the user for the delegated citation style.'
const DELEGATED_USER_QUESTION_NAME_TWO = 'Delegated citation reviewer'
const DELEGATED_WAIT_MARKER = 'Wait until the Main Agent stops'
const DELEGATED_WAIT_TASK = `${DELEGATED_WAIT_MARKER} delegated fixture A.`
const DELEGATED_WAIT_TASK_TWO = `${DELEGATED_WAIT_MARKER} delegated fixture B.`
const DELEGATED_WAIT_NAME = 'Delegated fixture A'
const DELEGATED_WAIT_NAME_TWO = 'Delegated fixture B'
const DELEGATED_STRUCTURED_OUTPUT_TASK = 'Create certified structured evidence.'
const DELEGATED_RELIABLE_MESSAGING_TASK = 'Send a reliable question to Main.'
const DELEGATED_RELIABLE_PARK_TASK = 'Queue a reliable question for branch parking.'
const DELEGATED_RELIABLE_FAILURE_TASK = 'Queue a reliable question for post-fence failure.'
const DELEGATED_RELIABLE_FAILURE_NAME = 'Post-fence reliable question'
const DELEGATED_RELIABLE_FAIRNESS_TASK_A = 'Queue reliable fairness question A.'
const DELEGATED_RELIABLE_FAIRNESS_TASK_B = 'Queue reliable fairness question B.'
const RELIABLE_CHILD_DIRECTIVE = 'Use the renderer-visible reliable evidence.'
const DELEGATED_BRANCH_A_TASK = `${DELEGATED_WAIT_MARKER} inactive branch child A.`
const DELEGATED_BRANCH_B_TASK = `${DELEGATED_WAIT_MARKER} active branch child B1.`
const DELEGATED_BRANCH_B_TASK_TWO = `${DELEGATED_WAIT_MARKER} active branch child B2.`
const DELEGATED_BRANCH_A_NAME = 'Inactive branch child A'
const DELEGATED_BRANCH_B_NAME = 'Active branch child B1'
const DELEGATED_BRANCH_B_NAME_TWO = 'Active branch child B2'
const CONTEXT_COMPACTION_PROMPT = 'Preview context compaction.'
const CITATION_PREVIEW_PROMPT = 'Preview a cited source.'

const sessionRoutes = new Map()
const sessionCancellationResolvers = new Map()
const reliableMessagingChildren = new Map()

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const suspendSessionWrites = async () => {
  const sessionsRoot = join(process.env.OPEN_SCIENCE_STORAGE_ROOT ?? '', 'sessions')
  const projects = await readdir(sessionsRoot, { withFileTypes: true })
  const directories = projects
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(sessionsRoot, entry.name))
  await Promise.all(directories.map((directory) => chmod(directory, 0o500)))
  return async () => Promise.all(directories.map((directory) => chmod(directory, 0o700)))
}

const stringEnvironment = (overrides = []) => {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry) => entry[1] !== undefined)
  )
  for (const entry of overrides) environment[entry.name] = entry.value
  return environment
}

const toolResult = (name, result) => {
  const text = result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
  if (result.isError) throw new Error(`${name} failed: ${text}`)
  return JSON.parse(text)
}

const frameworkServerName = (name) => name.replaceAll('-', '_')

const delegatedArtifactHandoff = async (mcpServers) => {
  const currentRunFile = mcpServers
    .flatMap((server) => server.env ?? [])
    .find((entry) => entry.name === 'OPEN_SCIENCE_ARTIFACT_CURRENT_RUN_FILE')?.value
  if (!currentRunFile) return {}
  const executionId = await readFile(currentRunFile, 'utf8')
    .then((content) => JSON.parse(content).executionId)
    .catch(() => undefined)
  return { artifactCurrentRunFile: currentRunFile, artifactExecutionId: executionId }
}

const parseMcpResponse = (body) => {
  const dataLine = body.split('\n').find((line) => line.startsWith('data:'))
  const json = dataLine ? dataLine.slice('data:'.length).trim() : body.trim()
  return json ? JSON.parse(json) : {}
}

const submitReviewerPass = async (mcpServers) => {
  const server = mcpServers.find((candidate) => candidate.type === 'http')
  if (!server?.url) return false
  const token =
    server.headers
      ?.find((header) => header.name?.toLowerCase() === 'authorization')
      ?.value?.replace('Bearer ', '') ?? ''
  const baseHeaders = {
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json'
  }
  const initialize = await fetch(server.url, {
    method: 'POST',
    headers: baseHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'open-science-e2e-reviewer', version: '1.0' }
      }
    })
  })
  if (!initialize.ok) throw new Error(`Reviewer MCP initialize failed: ${initialize.status}`)
  const initialized = parseMcpResponse(await initialize.text())
  const sessionId = initialize.headers.get('mcp-session-id')
  if (!sessionId || !initialized.result) {
    throw new Error('Reviewer MCP initialize did not return a session.')
  }
  const headers = { ...baseHeaders, 'mcp-session-id': sessionId }
  await fetch(server.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
  })
  let nextId = 2
  const callTool = async (name, args) => {
    const response = await fetch(server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name, arguments: args }
      })
    })
    if (!response.ok) throw new Error(`${name} failed: ${response.status}`)
    const payload = parseMcpResponse(await response.text())
    if (payload.error) throw new Error(`${name} failed: ${payload.error.message ?? 'unknown'}`)
    if (payload.result?.isError) {
      throw new Error(payload.result.content?.[0]?.text ?? `${name} returned an error`)
    }
    return payload.result
  }
  await callTool('read_turn', {})
  await callTool('submit_findings', {
    checks: [
      {
        status: 'pass',
        claim: 'The completed turn follows the requested production path.',
        evidence: 'The Reviewer read the frozen turn through its scoped evidence server.'
      }
    ]
  })
  return true
}

const withMcpClient = async (sessionId, serverName, operation) => {
  const route = sessionRoutes.get(sessionId)
  const server = route?.mcpServers?.find(
    (candidate) =>
      candidate.name === serverName || candidate.name === frameworkServerName(serverName)
  )
  if (!route || !server?.command) {
    const routed = route?.mcpServers?.map((candidate) => candidate.name).join(', ') || 'none'
    throw new Error(`${serverName} was not routed to ${sessionId}; routed servers: ${routed}.`)
  }

  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args ?? [],
    cwd: route.cwd,
    env: stringEnvironment(server.env)
  })
  const client = new Client({ name: 'open-science-e2e-agent', version: VERSION })
  await client.connect(transport)
  try {
    return await operation(client)
  } finally {
    await client.close()
  }
}

const executeControlCode = async (sessionId, code) =>
  withMcpClient(sessionId, 'open-science-notebook', async (client) =>
    toolResult(
      'repl_execute',
      await client.callTool({
        name: 'repl_execute',
        arguments: { code, timeoutMs: 120_000 }
      })
    )
  )

const controlResultValue = (execution) => {
  if (execution?.status !== 'completed') {
    throw new Error(`Control REPL execution failed: ${JSON.stringify(execution)}`)
  }
  const text = execution.outputs
    ?.map((output) => output?.data?.['text/plain'])
    .find((value) => typeof value === 'string')
  if (typeof text !== 'string') {
    throw new Error(`Control REPL returned no display value: ${JSON.stringify(execution)}`)
  }
  return JSON.parse(text)
}

const runProductionDelegationRequest = async (sessionId, request, wait) =>
  executeControlCode(
    sessionId,
    `return await host.delegate(${JSON.stringify(request)}, { wait: ${String(wait)} })`
  )

const runProductionDelegation = async (sessionId, task, name, wait) =>
  runProductionDelegationRequest(sessionId, { task, name }, wait)

const runProductionTimedDelegationRequest = async (sessionId, request) =>
  executeControlCode(
    sessionId,
    `return await host.delegate(${JSON.stringify(request)}, { timeoutSeconds: 0 })`
  )

const waitForSessionCancellation = (sessionId) =>
  new Promise((resolve) => {
    sessionCancellationResolvers.set(sessionId, resolve)
  })

const captureDelegatedHandoff = async (sessionId, task) => {
  const captureRoot = process.env.OPEN_SCIENCE_E2E_HANDOFF_CAPTURE_ROOT
  if (!captureRoot) throw new Error('The delegated handoff capture root is unavailable.')
  const route = sessionRoutes.get(sessionId)
  const currentRunFile = route?.artifactCurrentRunFile
  if (!currentRunFile)
    throw new Error('The delegated Artifact handoff was not routed to the Agent.')
  await mkdir(captureRoot, { recursive: true })
  const delegateName = task.includes(DELEGATED_BRANCH_B_TASK_TWO)
    ? DELEGATED_BRANCH_B_NAME_TWO
    : task.includes(DELEGATED_BRANCH_B_TASK)
      ? DELEGATED_BRANCH_B_NAME
      : task.includes(DELEGATED_BRANCH_A_TASK)
        ? DELEGATED_BRANCH_A_NAME
        : task.includes(DELEGATED_WAIT_TASK_TWO)
          ? DELEGATED_WAIT_NAME_TWO
          : task.includes(DELEGATED_WAIT_TASK)
            ? DELEGATED_WAIT_NAME
            : task
  const captureKey = Buffer.from(delegateName).toString('base64url')
  const sabotagePlan = join(captureRoot, `${captureKey}.sabotage`)
  const shouldSabotage = await readFile(sabotagePlan, 'utf8')
    .then(() => true)
    .catch(() => false)
  if (!shouldSabotage) return
  await rm(sabotagePlan, { force: true })
  await writeFile(
    join(captureRoot, `${captureKey}.json`),
    JSON.stringify({ executionId: route.artifactExecutionId, handoffPath: currentRunFile })
  )
}

const captureProviderPrompt = async (sessionId, prompt) => {
  const captureRoot = process.env.OPEN_SCIENCE_E2E_HANDOFF_CAPTURE_ROOT
  if (!captureRoot) return
  await mkdir(captureRoot, { recursive: true })
  await appendFile(
    join(captureRoot, 'provider-prompts.jsonl'),
    `${JSON.stringify({
      sessionId,
      role: sessionRoutes.get(sessionId)?.artifactCurrentRunFile ? 'delegate' : 'main',
      prompt
    })}\n`,
    'utf8'
  )
}

const verifyProviderBridge = () => {
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}')
  const providers = Object.values(config.provider ?? {})
  const route = providers.find((provider) => provider?.models?.['e2e-model'])
  const credentialName = route?.options?.apiKey?.match(/^\{env:([^}]+)\}$/)?.[1]
  const credential = credentialName ? process.env[credentialName] : undefined
  if (!route?.options?.baseURL || !credential)
    throw new Error('The persisted provider route did not reach the Agent process.')
  const direct = route.options.baseURL === 'http://127.0.0.1:9/v1' && credential === 'e2e-key'
  const url = new URL(route.options.baseURL)
  const bridged = url.hostname === '127.0.0.1' && url.pathname === '/v1' && url.port !== '9'
  if (!direct && !bridged)
    throw new Error(
      `The persisted provider route did not reach the Agent process ` +
        `(base URL: ${route.options.baseURL}, credential: present).`
    )
  return 'Provider bridge verified through the Agent process.'
}

const assertValidModelLimits = () => {
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}')
  for (const [providerId, provider] of Object.entries(config.provider ?? {})) {
    for (const [modelId, model] of Object.entries(provider?.models ?? {})) {
      if (model?.limit === undefined) continue
      const { context, input, output } = model.limit
      const valid = (value) => Number.isSafeInteger(value) && value > 0
      if (!valid(context) || !valid(output) || (input !== undefined && !valid(input))) {
        throw new Error(
          `Invalid OpenCode model limits for ${providerId}/${modelId}: ${JSON.stringify(model.limit)}`
        )
      }
    }
  }
}

const verifyNotebookLifecycle = async (sessionId, delayMs = 0) =>
  withMcpClient(sessionId, 'open-science-notebook', async (client) => {
    const initial = toolResult(
      'notebook_state',
      await client.callTool({ name: 'notebook_state', arguments: {} })
    )
    const execution = toolResult(
      'bash_execute',
      await client.callTool({
        name: 'bash_execute',
        arguments: {
          command: `node -e "setTimeout(() => console.log('notebook-lifecycle-e2e'), ${delayMs})"`
        }
      })
    )
    const after = toolResult(
      'notebook_state',
      await client.callTool({ name: 'notebook_state', arguments: {} })
    )
    const shutdown = toolResult(
      'notebook_shutdown',
      await client.callTool({ name: 'notebook_shutdown', arguments: {} })
    )
    if (
      initial.sessionId !== after.sessionId ||
      !execution.stdout?.includes('notebook-lifecycle-e2e') ||
      shutdown.status !== 'shutdown'
    ) {
      throw new Error('The Notebook lifecycle did not preserve its session and output.')
    }
    return `Notebook lifecycle verified for ${initial.sessionId}.`
  })

const createProvenanceArtifact = async (sessionId) => {
  const producerRunId = await withMcpClient(sessionId, 'open-science-notebook', async (client) => {
    const before = toolResult(
      'notebook_state',
      await client.callTool({ name: 'notebook_state', arguments: {} })
    )
    const existingRunIds = new Set(
      before.recentRuns?.map((candidate) => candidate.runId).filter(Boolean) ?? []
    )
    const execution = toolResult(
      'bash_execute',
      await client.callTool({
        name: 'bash_execute',
        arguments: { command: "printf 'artifact-provenance-e2e\\n'" }
      })
    )
    const state = toolResult(
      'notebook_state',
      await client.callTool({ name: 'notebook_state', arguments: {} })
    )
    const run = state.recentRuns
      ?.toReversed()
      .find(
        (candidate) =>
          candidate.kernelKind === 'bash' &&
          candidate.status === 'completed' &&
          !existingRunIds.has(candidate.runId)
      )
    if (!execution.stdout?.includes('artifact-provenance-e2e') || !run?.runId) {
      throw new Error(
        `The Notebook did not persist the Bash producer run: ${JSON.stringify({ execution, recentRuns: state.recentRuns })}`
      )
    }
    return run.runId
  })
  const stored = await withMcpClient(sessionId, 'open-science-artifacts', async (client) =>
    toolResult(
      'write_artifact_file',
      await client.callTool({
        name: 'write_artifact_file',
        arguments: {
          filename: 'provenance-evidence.txt',
          mimeType: 'text/plain',
          content: 'artifact provenance e2e',
          encoding: 'utf8',
          producerRunId
        }
      })
    )
  )
  if (!stored.artifact?.version_id || stored.artifact.producer_run_id !== producerRunId) {
    throw new Error('The artifact Version did not retain its Notebook producer run.')
  }
  return `Artifact provenance verified for session ${sessionId}, artifact ${stored.artifact.artifact_id}, version ${stored.artifact.version_id}.`
}

const createPreviewContextMenuArtifacts = async (sessionId) => {
  const stored = await withMcpClient(sessionId, 'open-science-artifacts', async (client) => {
    const html = toolResult(
      'write_artifact_file',
      await client.callTool({
        name: 'write_artifact_file',
        arguments: {
          filename: 'context-menu.html',
          mimeType: 'text/html',
          content:
            '<!doctype html><html><body><main><h1>HTML context menu fixture</h1><p data-preview-context-menu-passthrough>Managed native context area</p><p>Managed frame content.</p></main></body></html>',
          encoding: 'utf8'
        }
      })
    )
    const office = toolResult(
      'write_artifact_file',
      await client.callTool({
        name: 'write_artifact_file',
        arguments: {
          filename: 'context-menu.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          content: PREVIEW_CONTEXT_MENU_DOCX_BASE64,
          encoding: 'base64'
        }
      })
    )
    const spreadsheet = toolResult(
      'write_artifact_file',
      await client.callTool({
        name: 'write_artifact_file',
        arguments: {
          filename: 'context-menu.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          content: await createPreviewContextMenuXlsxBase64(),
          encoding: 'base64'
        }
      })
    )
    return { html, office, spreadsheet }
  })
  if (
    !stored.html.artifact?.version_id ||
    !stored.office.artifact?.version_id ||
    !stored.spreadsheet.artifact?.version_id
  ) {
    throw new Error('Preview context menu artifacts were not finalized.')
  }
  return 'Preview context menu artifacts created.'
}

const runArtifactVersionInputDelegation = async (sessionId) => {
  const produced = controlResultValue(
    await runProductionDelegationRequest(
      sessionId,
      {
        task: DELEGATED_STRUCTURED_OUTPUT_TASK,
        name: DELEGATED_ARTIFACT_VERSION_PRODUCER_NAME,
        outputSchema: {
          type: 'object',
          required: ['count'],
          properties: { count: { type: 'number' } },
          additionalProperties: false
        }
      },
      true
    )
  )
  const producer = produced.children?.[0]
  const versionId = producer?.artifactsCreated?.[0]?.versionId
  if (producer?.status !== 'completed' || !versionId) {
    throw new Error(
      `The producer child returned no immutable versionId: ${JSON.stringify(produced)}`
    )
  }
  const delegated = await runProductionDelegationRequest(
    sessionId,
    {
      task: DELEGATED_ARTIFACT_VERSION_INPUT_TASK,
      name: DELEGATED_ARTIFACT_VERSION_INPUT_NAME,
      inputs: [versionId]
    },
    true
  )
  if (delegated.status !== 'completed') {
    throw new Error(`Artifact Version input delegation failed: ${JSON.stringify(delegated)}`)
  }
  return 'Artifact Version input delegation completed.'
}

if (process.argv.includes('--version')) {
  process.stdout.write(`${VERSION}\n`)
} else {
  assertValidModelLimits()
  let nextMessageId = 1
  let nextSessionId = 1

  const app = acp
    .agent({ name: 'open-science-e2e-agent' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities: { close: {}, resume: {} }
      },
      authMethods: []
    }))
    .onRequest(acp.methods.agent.authenticate, () => ({}))
    .onRequest(acp.methods.agent.session.new, async (context) => {
      const sessionId = `e2e-session-${nextSessionId++}`
      const mcpServers = context.params.mcpServers ?? []
      sessionRoutes.set(sessionId, {
        cwd: context.params.cwd,
        mcpServers,
        ...(await delegatedArtifactHandoff(mcpServers))
      })
      return { sessionId }
    })
    .onRequest(acp.methods.agent.session.resume, async (context) => {
      const mcpServers = context.params.mcpServers ?? []
      sessionRoutes.set(context.params.sessionId, {
        cwd: context.params.cwd,
        mcpServers,
        ...(await delegatedArtifactHandoff(mcpServers))
      })
      return {}
    })
    .onRequest(acp.methods.agent.session.prompt, async (context) => {
      const prompt = context.params.prompt
        .map((content) => (content.type === 'text' ? content.text : ''))
        .join('')
      await captureProviderPrompt(context.params.sessionId, prompt)

      if (prompt.includes(DELEGATED_WAIT_MARKER)) {
        await captureDelegatedHandoff(
          context.params.sessionId,
          prompt.includes(DELEGATED_BRANCH_B_TASK_TWO) ? DELEGATED_BRANCH_B_TASK_TWO : prompt
        )
        await waitForSessionCancellation(context.params.sessionId)
        return { stopReason: 'cancelled' }
      }

      if (prompt.includes(DELEGATED_ARTIFACT_VERSION_INPUT_TASK)) {
        const route = sessionRoutes.get(context.params.sessionId)
        if (!route?.cwd) throw new Error('The delegated working directory is unavailable.')
        const inputPath = join(route.cwd, 'inputs', '01-provenance-evidence.txt')
        const content = await readFile(inputPath, 'utf8')
        if (content !== 'artifact provenance e2e') {
          throw new Error(`Delegated Artifact Version input mismatch: ${JSON.stringify(content)}`)
        }
        await context.client.notify(acp.methods.client.session.update, {
          sessionId: context.params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: `e2e-message-${nextMessageId++}`,
            content: { type: 'text', text: 'Delegated immutable Artifact Version input verified.' }
          }
        })
        return { stopReason: 'end_turn' }
      }

      if (prompt.includes(DELEGATION_STOP_PROMPT)) {
        await runProductionDelegationRequest(
          context.params.sessionId,
          [
            { task: DELEGATED_WAIT_TASK, name: DELEGATED_WAIT_NAME },
            { task: DELEGATED_WAIT_TASK_TWO, name: DELEGATED_WAIT_NAME_TWO }
          ],
          false
        )
        await context.client.notify(acp.methods.client.session.update, {
          sessionId: context.params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: `e2e-message-${nextMessageId++}`,
            content: { type: 'text', text: 'Production delegation is running.' }
          }
        })
        await waitForSessionCancellation(context.params.sessionId)
        return { stopReason: 'cancelled' }
      }

      let reply = 'Deterministic reply: Summarize the deterministic fixture.'
      try {
        if (prompt.includes(MEMORY_RECALL_PROMPT)) {
          if (!prompt.includes('<memory_records>') || !prompt.includes(MEMORY_RECALL_ENTRY)) {
            throw new Error('Automatic memory recall did not reach the provider prompt.')
          }
          reply = 'Automatic memory recall reached the provider.'
        } else if (prompt.includes(BUFFERED_TEXT_TOOL_LAYOUT_SHIFT_PROMPT)) {
          const intentMessageId = `e2e-message-${nextMessageId++}`
          await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: intentMessageId,
              content: { type: 'text', text: 'Next step.' }
            }
          })
          // Leave the text fragment as the trailing item long enough for its presentation buffer
          // to drain while the Thinking row remains visible, matching a real model that pauses
          // before issuing its tool call.
          await delay(2_000)
          await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'e2e-buffered-layout-tool',
              title: 'Buffered layout probe',
              kind: 'other',
              status: 'in_progress'
            }
          })
          await delay(2_000)
          await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'e2e-buffered-layout-tool',
              title: 'Buffered layout probe',
              status: 'completed'
            }
          })
          reply = ''
        } else if (
          prompt.includes(TOOL_LAYOUT_SHIFT_PROMPT) ||
          prompt.includes(TOOL_STATUS_LAYOUT_SHIFT_PROMPT)
        ) {
          // Keep the completed tool group on screen before streaming the final Markdown so the
          // renderer test can observe whether the existing row moves while the next row mounts.
          await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'e2e-layout-tool-1',
              title: 'Prepare layout fixture',
              kind: 'other',
              status: 'in_progress'
            }
          })
          await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'e2e-layout-tool-1',
              title: 'Layout probe completed',
              status: 'completed'
            }
          })
          if (prompt.includes(TOOL_STATUS_LAYOUT_SHIFT_PROMPT)) {
            process.stderr.write('Layout fixture status.\n')
          }
          await delay(prompt.includes(TOOL_STATUS_LAYOUT_SHIFT_PROMPT) ? 2_000 : 750)

          const finalMessageId = `e2e-message-${nextMessageId++}`
          await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: finalMessageId,
              content: { type: 'text', text: 'Layout fixture complete.' }
            }
          })
          reply = ''
        } else if (prompt.includes(TOOL_ORDER_PROMPT)) {
          // Mirrors a real agent turn: intent text, a slow tool call, then follow-up text.
          const intentMessageId = `e2e-message-${nextMessageId++}`
          // A long intent text, chunked quickly so live pacing trails far behind arrival.
          for (let chunk = 0; chunk < 20; chunk += 1) {
            await context.client.notify(acp.methods.client.session.update, {
              sessionId: context.params.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                messageId: intentMessageId,
                content: {
                  type: 'text',
                  text: `Intent paragraph ${chunk}: I will now run the slow tool for you. `
                }
              }
            })
            await delay(30)
          }
          await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'e2e-order-tool',
              title: 'Slow ordered tool',
              kind: 'other',
              status: 'in_progress'
            }
          })
          await delay(2_000)
          await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'e2e-order-tool',
              title: 'Slow ordered tool',
              status: 'completed'
            }
          })
          const followUpMessageId = `e2e-message-${nextMessageId++}`
          await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: followUpMessageId,
              content: { type: 'text', text: 'The slow tool has finished running.' }
            }
          })
          reply = ''
        } else if (prompt.includes(RUNTIME_RESOURCE_STRESS_PROMPT)) {
          const stressMessageId = `e2e-message-${nextMessageId++}`
          const payload = 'x'.repeat(2_048)
          for (let chunk = 0; chunk < 90; chunk += 1) {
            await context.client.notify(acp.methods.client.session.update, {
              sessionId: context.params.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                messageId: stressMessageId,
                content: {
                  type: 'text',
                  text: `Resource stress chunk ${chunk}: ${payload}\n`
                }
              }
            })
            await delay(30)
          }
          reply = 'Runtime resource stress journey complete.'
        } else if (prompt.includes(LONG_STREAM_PROMPT)) {
          // Mirror a real agent turn: text segment -> tool call -> second text segment ->
          // tool completion -> trailing segment, with separate message ids per segment.
          const streamSegment = async (segment, paragraphs) => {
            const streamMessageId = `e2e-message-${nextMessageId++}`
            for (let chunk = 0; chunk < paragraphs; chunk += 1) {
              await context.client.notify(acp.methods.client.session.update, {
                sessionId: context.params.sessionId,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  messageId: streamMessageId,
                  content: {
                    type: 'text',
                    text: `Segment ${segment} paragraph ${chunk}. The quick brown fox jumps over the lazy dog.\n\n`
                  }
                }
              })
              await delay(50)
            }
          }

          await streamSegment(1, 12)
          await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'e2e-scroll-tool-mid',
              title: 'Mid-turn tool call',
              kind: 'other',
              status: 'in_progress'
            }
          })
          await delay(200)
          await streamSegment(2, 16)
          await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'e2e-scroll-tool-mid',
              title: 'Mid-turn tool call',
              status: 'completed'
            }
          })
          await streamSegment(3, 8)
          reply = ''
        } else if (prompt.includes(QUEUE_GATE_PROMPT)) {
          // Regression journey for queue dispatch gating: a slow lead-in, then one large final
          // chunk so the renderer's paced reveal trails the store-complete state by seconds.
          // An ungated queue would dispatch the next message mid-reveal.
          const gateMessageId = `e2e-message-${nextMessageId++}`
          for (let chunk = 0; chunk < 4; chunk += 1) {
            await context.client.notify(acp.methods.client.session.update, {
              sessionId: context.params.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                messageId: gateMessageId,
                content: { type: 'text', text: `Queue gate lead-in chunk ${chunk}.\n\n` }
              }
            })
            await delay(50)
          }
          await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: gateMessageId,
              content: {
                type: 'text',
                text: 'Queue gate backlog paragraph: the reveal keeps pacing after the store completes. '.repeat(
                  200
                )
              }
            }
          })
          reply = ''
        } else if (prompt.includes(CITATION_PREVIEW_PROMPT)) {
          reply =
            'The fixture evidence supports this claim ([Torre et al. 2026](https://citation.example/paper "Fixture study")), with an independent replication ([Chen et al. 2026](https://citation.example/replication "Replication study")).'
        } else if (
          await submitReviewerPass(sessionRoutes.get(context.params.sessionId)?.mcpServers ?? [])
        ) {
          reply = ''
        } else if (prompt.includes(CONTEXT_COMPACTION_PROMPT)) {
          await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'e2e-context-compaction',
              title: 'Context compacting',
              kind: 'other',
              status: 'in_progress',
              _meta: { contextCompaction: true }
            }
          })
          await delay(1_500)
          await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'e2e-context-compaction',
              title: 'Context compacted',
              status: 'completed',
              _meta: { contextCompaction: true }
            }
          })
          reply = 'Compaction preview complete.'
        } else if (prompt.includes(PROVIDER_BRIDGE_PROMPT)) {
          reply = verifyProviderBridge()
        } else if (prompt.includes(NOTEBOOK_LIFECYCLE_PROMPT)) {
          reply = await verifyNotebookLifecycle(context.params.sessionId)
        } else if (prompt.includes(PERFORMANCE_NOTEBOOK_LIFECYCLE_PROMPT)) {
          reply = await verifyNotebookLifecycle(context.params.sessionId, 1_500)
        } else if (prompt.includes(ARTIFACT_PROVENANCE_PROMPT)) {
          reply = await createProvenanceArtifact(context.params.sessionId)
        } else if (prompt.includes(PREVIEW_CONTEXT_MENU_ARTIFACTS_PROMPT)) {
          reply = await createPreviewContextMenuArtifacts(context.params.sessionId)
        } else if (prompt.includes(DELEGATION_TERMINAL_PROMPT)) {
          const delegated = await runProductionDelegation(
            context.params.sessionId,
            DELEGATED_TERMINAL_TASK,
            DELEGATED_TERMINAL_NAME,
            true
          )
          if (delegated.status !== 'completed') {
            throw new Error(`Production delegation failed: ${JSON.stringify(delegated)}`)
          }
          reply = 'Production delegation reached a terminal result.'
        } else if (prompt.includes(DELEGATION_ARTIFACT_VERSION_INPUT_PROMPT)) {
          reply = await runArtifactVersionInputDelegation(context.params.sessionId)
        } else if (prompt.includes(DELEGATION_BOUNDED_COLLECT_PROMPT)) {
          const dispatched = controlResultValue(
            await executeControlCode(
              context.params.sessionId,
              `globalThis.s2Pending = await host.delegate([{ task: ${JSON.stringify(DELEGATED_TERMINAL_TASK)}, name: "Bounded terminal child" }, { task: ${JSON.stringify(DELEGATED_BOUNDED_SLOW_TASK)}, name: ${JSON.stringify(DELEGATED_BOUNDED_SLOW_TASK)} }], { timeoutSeconds: 1 }); return globalThis.s2Pending`
            )
          )
          if (
            dispatched.kind !== 'observations' ||
            dispatched.children.length !== 2 ||
            dispatched.children[0].status !== 'completed' ||
            dispatched.children[1].status !== 'running' ||
            Object.hasOwn(dispatched.children[1], 'artifactsCreated')
          ) {
            throw new Error(`Timed delegate observation failed: ${JSON.stringify(dispatched)}`)
          }
          reply = 'Production bounded delegate returned while a Subagent kept running.'
        } else if (prompt.includes(DELEGATION_BOUNDED_RECOLLECT_PROMPT)) {
          const terminal = controlResultValue(
            await executeControlCode(
              context.params.sessionId,
              `const slow = globalThis.s2Pending.children[1]; return await host.collect([{ frameId: slow.frameId, attemptId: slow.attemptId }], { timeoutSeconds: 30 })`
            )
          )
          if (terminal.length !== 1 || terminal[0].status !== 'completed') {
            throw new Error(`Bounded terminal recollect failed: ${JSON.stringify(terminal)}`)
          }
          reply = 'Production bounded collect journey completed.'
        } else if (prompt.includes(DELEGATION_PERMISSION_PROMPT)) {
          await runProductionDelegation(
            context.params.sessionId,
            DELEGATED_PERMISSION_TASK,
            DELEGATED_PERMISSION_TASK,
            true
          )
          reply = 'Production delegated permission journey completed.'
        } else if (prompt.includes(DELEGATION_USER_QUESTION_PROMPT)) {
          await runProductionDelegation(
            context.params.sessionId,
            DELEGATED_USER_QUESTION_TASK,
            DELEGATED_USER_QUESTION_NAME,
            false
          )
          await runProductionDelegation(
            context.params.sessionId,
            DELEGATED_USER_QUESTION_TASK_TWO,
            DELEGATED_USER_QUESTION_NAME_TWO,
            false
          )
          reply = 'Production delegated user question is pending.'
        } else if (prompt.includes(DELEGATION_BRANCH_A_PROMPT)) {
          await runProductionTimedDelegationRequest(context.params.sessionId, {
            task: DELEGATED_BRANCH_A_TASK,
            name: DELEGATED_BRANCH_A_NAME
          })
          reply = 'Inactive branch child A is running.'
        } else if (prompt.includes(DELEGATION_BRANCH_B_PROMPT)) {
          await runProductionTimedDelegationRequest(context.params.sessionId, [
            { task: DELEGATED_BRANCH_B_TASK, name: DELEGATED_BRANCH_B_NAME },
            { task: DELEGATED_BRANCH_B_TASK_TWO, name: DELEGATED_BRANCH_B_NAME_TWO }
          ])
          reply = 'Active branch children B1 and B2 are running.'
        } else if (prompt.includes(DELEGATION_UNAVAILABLE_PROMPT)) {
          const delegated = await executeControlCode(
            context.params.sessionId,
            `return await host.delegate({ task: ${JSON.stringify(DELEGATED_TERMINAL_TASK)}, name: ${JSON.stringify(DELEGATED_TERMINAL_NAME)}, profile: "missing-e2e-specialist" }, { wait: true })`
          )
          if (delegated.status !== 'failed') {
            throw new Error(`Unsupported delegation was admitted: ${JSON.stringify(delegated)}`)
          }
          reply = 'Subagents are unavailable for this session configuration.'
        } else if (prompt.includes(DELEGATION_INHERITED_SPECIALIST_PROMPT)) {
          const delegated = controlResultValue(
            await runProductionDelegation(
              context.params.sessionId,
              DELEGATED_TERMINAL_TASK,
              DELEGATED_INHERITED_SPECIALIST_NAME,
              true
            )
          )
          if (
            delegated.kind !== 'results' ||
            delegated.children?.[0]?.status !== 'completed' ||
            delegated.children?.[0]?.agentName !== 'Release Specialist'
          ) {
            throw new Error(`Inherited Specialist delegation failed: ${JSON.stringify(delegated)}`)
          }
          reply = 'Production inherited Specialist delegation completed.'
        } else if (prompt.includes(RELIABLE_MESSAGING_PROMPT)) {
          const dispatched = controlResultValue(
            await runProductionDelegationRequest(
              context.params.sessionId,
              { task: DELEGATED_RELIABLE_MESSAGING_TASK, name: DELEGATED_RELIABLE_MESSAGING_TASK },
              false
            )
          )
          const child = dispatched.children?.[0]
          if (!child?.frameId || !child?.attemptId) {
            throw new Error(`Reliable child admission failed: ${JSON.stringify(dispatched)}`)
          }
          reliableMessagingChildren.set(context.params.sessionId, child.frameId)
          const downward = controlResultValue(
            await executeControlCode(
              context.params.sessionId,
              `const sent = await host.sendFrameMessage(${JSON.stringify(child.frameId)}, ${JSON.stringify(RELIABLE_CHILD_DIRECTIVE)}, { kind: "info", requestId: "e2e-main-to-child" }); return await host.messageReceipt(sent.messageId, { timeoutSeconds: 30 })`
            )
          )
          if (downward.status !== 'accepted' || downward.direction !== 'to_child') {
            throw new Error(`Reliable downward delivery failed: ${JSON.stringify(downward)}`)
          }
          reply = 'Production reliable downward message was accepted.'
        } else if (prompt.includes(RELIABLE_BRANCH_PARK_PROMPT)) {
          await runProductionDelegationRequest(
            context.params.sessionId,
            { task: DELEGATED_RELIABLE_PARK_TASK, name: DELEGATED_RELIABLE_PARK_TASK },
            false
          )
          await delay(500)
          await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: `e2e-message-${nextMessageId++}`,
              content: { type: 'text', text: 'Branch park upward message queued.' }
            }
          })
          await delay(2_000)
          reply = 'Reliable branch park source turn completed.'
        } else if (prompt.includes(RELIABLE_BRANCH_WAKE_PROMPT)) {
          const receipt = controlResultValue(
            await executeControlCode(
              context.params.sessionId,
              `return await host.messageReceipt("e2e-child-park", { timeoutSeconds: 0 })`
            )
          )
          if (receipt.status !== 'queued') {
            throw new Error(
              `Reliable parked receipt changed before wake: ${JSON.stringify(receipt)}`
            )
          }
          reply = 'Reliable branch wake admitted.'
        } else if (prompt.includes(RELIABLE_FAILURE_PROMPT)) {
          await runProductionDelegationRequest(
            context.params.sessionId,
            { task: DELEGATED_RELIABLE_FAILURE_TASK, name: DELEGATED_RELIABLE_FAILURE_NAME },
            false
          )
          await delay(500)
          reply = 'Reliable post-fence source turn completed.'
        } else if (prompt.includes(RELIABLE_FAILURE_OBSERVE_PROMPT)) {
          const messageId = prompt.match(/Message ID (message-[a-f0-9]+)/u)?.[1]
          if (!messageId) throw new Error('Reliable post-fence Message identity is unavailable.')
          const receipt = controlResultValue(
            await executeControlCode(
              context.params.sessionId,
              `return await host.messageReceipt(${JSON.stringify(messageId)}, { timeoutSeconds: 0 })`
            )
          )
          if (receipt.status !== 'uncertain') {
            throw new Error(`Post-fence recovery was not uncertain: ${JSON.stringify(receipt)}`)
          }
          reply = 'Reliable post-fence uncertainty recovered.'
        } else if (prompt.includes(RELIABLE_FAIRNESS_PROMPT)) {
          await runProductionDelegationRequest(
            context.params.sessionId,
            [
              {
                task: DELEGATED_RELIABLE_FAIRNESS_TASK_A,
                name: DELEGATED_RELIABLE_FAIRNESS_TASK_A
              },
              { task: DELEGATED_RELIABLE_FAIRNESS_TASK_B, name: DELEGATED_RELIABLE_FAIRNESS_TASK_B }
            ],
            false
          )
          await delay(700)
          await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: `e2e-message-${nextMessageId++}`,
              content: { type: 'text', text: 'Two upward lanes are queued.' }
            }
          })
          await delay(1_500)
          reply = 'Reliable fairness source turn completed.'
        } else if (prompt.includes(SUBAGENT_MODEL_BATCH_PROMPT)) {
          const delegated = controlResultValue(
            await runProductionDelegationRequest(
              context.params.sessionId,
              [
                {
                  task: `${DELEGATED_TERMINAL_TASK} batch A`,
                  name: 'Certified terminal batch A'
                },
                {
                  task: `${DELEGATED_TERMINAL_TASK} batch B`,
                  name: 'Certified terminal batch B'
                }
              ],
              true
            )
          )
          if (
            delegated.kind !== 'results' ||
            delegated.children?.length !== 2 ||
            delegated.children.some((child) => child.status !== 'completed')
          ) {
            throw new Error(`Subagent model batch failed: ${JSON.stringify(delegated)}`)
          }
          reply = 'Subagent model batch completed.'
        } else if (prompt.includes(SUBAGENT_MODEL_CONTINUATION_START_PROMPT)) {
          const delegated = controlResultValue(
            await runProductionDelegation(
              context.params.sessionId,
              DELEGATED_TERMINAL_TASK,
              DELEGATED_MODEL_CONTINUATION_NAME,
              true
            )
          )
          const child = delegated.children?.[0]
          if (delegated.kind !== 'results' || child?.status !== 'completed') {
            throw new Error(`Subagent model initial Attempt failed: ${JSON.stringify(delegated)}`)
          }
          globalThis.subagentModelContinuationFrameId = child.frameId
          reply = 'Subagent model initial Attempt completed.'
        } else if (prompt.includes(SUBAGENT_MODEL_CONTINUATION_FINISH_PROMPT)) {
          const frameId = globalThis.subagentModelContinuationFrameId
          if (!frameId) throw new Error('Subagent model continuation Frame was not captured.')
          const continued = controlResultValue(
            await executeControlCode(
              context.params.sessionId,
              `const receipt = await host.sendFrameMessage(${JSON.stringify(frameId)}, "Continue after Settings changed"); return await host.collect([{ frameId: receipt.targetFrameId, attemptId: receipt.continuationAttemptId }], { timeoutSeconds: 30 })`
            )
          )
          if (continued.length !== 1 || continued[0].status !== 'completed') {
            throw new Error(`Subagent model continuation failed: ${JSON.stringify(continued)}`)
          }
          reply = 'Subagent model continuation completed.'
        } else if (prompt.includes(SUBAGENT_MODEL_UNAVAILABLE_PROMPT)) {
          const delegated = await executeControlCode(
            context.params.sessionId,
            'return await host.delegate([{ task: "Unavailable batch A", name: "Unavailable batch A" }, { task: "Unavailable batch B", name: "Unavailable batch B" }], { wait: false })'
          )
          if (delegated.status !== 'failed') {
            throw new Error(`Unavailable Subagent model was admitted: ${JSON.stringify(delegated)}`)
          }
          reply = 'Unavailable Subagent model rejected the whole batch.'
        } else if (prompt.includes(SUBAGENT_MODEL_INHERITED_PROMPT)) {
          const delegated = await runProductionDelegation(
            context.params.sessionId,
            'Complete the inherited Subagent model fixture.',
            'Inherited Subagent model fixture',
            true
          )
          if (delegated.status !== 'completed') {
            throw new Error(`Inherited Subagent model failed: ${JSON.stringify(delegated)}`)
          }
          reply = 'Inherited Subagent model completed.'
        } else if (prompt.includes(SUBAGENT_MODEL_HOLDER_PROMPT)) {
          reply = 'Global Active model holder completed.'
        } else if (prompt.includes(DELEGATION_STRUCTURED_OUTPUT_PROMPT)) {
          const delegated = controlResultValue(
            await runProductionDelegationRequest(
              context.params.sessionId,
              {
                task: DELEGATED_STRUCTURED_OUTPUT_TASK,
                name: DELEGATED_STRUCTURED_OUTPUT_TASK,
                outputSchema: {
                  type: 'object',
                  required: ['count'],
                  properties: { count: { type: 'number' } },
                  additionalProperties: false
                }
              },
              true
            )
          )
          const child = delegated.children?.[0]
          if (
            delegated.kind !== 'results' ||
            child?.status !== 'completed' ||
            child.response !== 'Structured child completed.' ||
            child.structuredOutput?.count !== 3 ||
            child.structuredOutputUnsatisfied !== false ||
            child.artifactsCreated?.length !== 1
          ) {
            throw new Error(`Structured delegation failed: ${JSON.stringify(delegated)}`)
          }
          reply = 'Production structured output journey completed.'
        } else if (prompt.includes(DELEGATED_STRUCTURED_OUTPUT_TASK)) {
          const submission = controlResultValue(
            await executeControlCode(
              context.params.sessionId,
              `let invalid = false; try { await host.submitOutput({ count: "three" }) } catch { invalid = true }; const receipt = await host.submitOutput({ count: 3 }); return { invalid, receipt }`
            )
          )
          if (!submission.invalid || submission.receipt?.accepted !== true) {
            throw new Error(`Structured submit contract failed: ${JSON.stringify(submission)}`)
          }
          await createProvenanceArtifact(context.params.sessionId)
          reply = 'Structured child completed.'
        } else if (prompt.includes(DELEGATED_RELIABLE_MESSAGING_TASK)) {
          await delay(250)
          const upward = controlResultValue(
            await executeControlCode(
              context.params.sessionId,
              `const sent = await host.sendFrameMessage("parent", "Child reliable question reached Main", { kind: "question", requestId: "e2e-child-to-main" }); return await host.messageReceipt(sent.messageId, { timeoutSeconds: 0 })`
            )
          )
          if (upward.status !== 'queued' || upward.direction !== 'to_parent') {
            throw new Error(`Reliable upward admission failed: ${JSON.stringify(upward)}`)
          }
          reply = 'Child sent a reliable question.'
        } else if (prompt.includes(DELEGATED_RELIABLE_PARK_TASK)) {
          const upward = controlResultValue(
            await executeControlCode(
              context.params.sessionId,
              `return await host.sendFrameMessage("parent", "Parked reliable child question", { kind: "question", requestId: "e2e-child-park" })`
            )
          )
          if (upward.status !== 'queued') {
            throw new Error(`Reliable parked admission failed: ${JSON.stringify(upward)}`)
          }
          reply = 'Child queued a branch-bound reliable question.'
        } else if (prompt.includes(DELEGATED_RELIABLE_FAILURE_TASK)) {
          await executeControlCode(
            context.params.sessionId,
            `return await host.sendFrameMessage("parent", "Trigger reliable post-fence persistence failure", { kind: "info", requestId: "e2e-child-post-fence" })`
          )
          reply = 'Child queued a post-fence reliable message.'
        } else if (
          prompt.includes(DELEGATED_RELIABLE_FAIRNESS_TASK_A) ||
          prompt.includes(DELEGATED_RELIABLE_FAIRNESS_TASK_B)
        ) {
          const suffix = prompt.includes(DELEGATED_RELIABLE_FAIRNESS_TASK_B) ? 'B' : 'A'
          await executeControlCode(
            context.params.sessionId,
            `return await host.sendFrameMessage("parent", "Reliable fairness child ${suffix}", { requestId: "e2e-fairness-${suffix.toLowerCase()}" })`
          )
          reply = `Child ${suffix} queued its reliable fairness message.`
        } else if (prompt.includes(RELIABLE_CHILD_DIRECTIVE)) {
          reply = 'Child received the reliable Main directive.'
        } else if (prompt.includes('Child reliable question reached Main')) {
          const childFrameId = reliableMessagingChildren.get(context.params.sessionId)
          if (!childFrameId) throw new Error('Reliable messaging child Frame was not retained.')
          const answered = controlResultValue(
            await executeControlCode(
              context.params.sessionId,
              `const sent = await host.sendFrameMessage(${JSON.stringify(childFrameId)}, "Main answered the reliable child question", { kind: "info", requestId: "e2e-main-reply-to-child" }); return await host.messageReceipt(sent.messageId, { timeoutSeconds: 30 })`
            )
          )
          if (answered.status !== 'accepted' || answered.direction !== 'to_child') {
            throw new Error(`Reliable root continuation reply failed: ${JSON.stringify(answered)}`)
          }
          reply = 'Main replied to the reliable child question from the root continuation.'
        } else if (prompt.includes('Main answered the reliable child question')) {
          reply = 'Child received the reliable root continuation reply.'
        } else if (prompt.includes('Parked reliable child question')) {
          reply = 'Main rendered the parked child question after branch restoration.'
        } else if (prompt.includes('Trigger reliable post-fence persistence failure')) {
          const restoreWrites = await suspendSessionWrites()
          try {
            await context.client.notify(acp.methods.client.session.update, {
              sessionId: context.params.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                messageId: `e2e-message-${nextMessageId++}`,
                content: { type: 'text', text: 'Provider acceptance crossed the durable fence.' }
              }
            })
            await delay(1_000)
          } finally {
            await restoreWrites()
          }
          reply = 'Persistence sabotage released.'
        } else if (prompt.includes('Reliable fairness child A')) {
          reply = 'Main rendered reliable fairness child A.'
        } else if (prompt.includes('Reliable fairness child B')) {
          reply = 'Main rendered reliable fairness child B.'
        } else if (prompt.includes(RELIABLE_FAIRNESS_USER_PROMPT)) {
          reply = 'Concurrent real user prompt completed.'
        } else if (prompt.includes(DELEGATED_BOUNDED_SLOW_TASK)) {
          await new Promise((resolve) => setTimeout(resolve, 3_000))
          reply = 'Delayed bounded child completed.'
        } else if (prompt.includes(DELEGATED_PERMISSION_TASK)) {
          const permission = await context.client.request(
            acp.methods.client.session.requestPermission,
            {
              sessionId: context.params.sessionId,
              toolCall: {
                toolCallId: 'e2e-delegated-permission-tool',
                title: 'Read delegated evidence'
              },
              options: [
                { kind: 'allow_once', name: 'Allow once', optionId: 'allow-once' },
                { kind: 'reject_once', name: 'Deny', optionId: 'deny-once' }
              ]
            }
          )
          reply =
            permission.outcome.outcome === 'selected' &&
            permission.outcome.optionId === 'allow-once'
              ? 'Delegated permission allowed.'
              : 'Delegated permission denied.'
        } else if (prompt.includes(DELEGATED_USER_QUESTION_TASK_TWO)) {
          const asked = await withMcpClient(
            context.params.sessionId,
            'open-science-notebook',
            async (client) =>
              toolResult(
                'ask_user_question',
                await client.callTool({
                  name: 'ask_user_question',
                  arguments: {
                    questions: [
                      {
                        header: 'Citations',
                        question: 'Which citation style should the reviewer use?',
                        options: [
                          { label: 'Inline', description: 'Place citations in the prose.' },
                          { label: 'Footnotes', description: 'Place citations in footnotes.' }
                        ]
                      }
                    ]
                  }
                })
              )
          )
          if (asked.action !== 'pending') {
            throw new Error(`Delegated question was not parked: ${JSON.stringify(asked)}`)
          }
          reply = 'Delegated citation question requested.'
        } else if (prompt.includes(DELEGATED_USER_QUESTION_TASK)) {
          const asked = await withMcpClient(
            context.params.sessionId,
            'open-science-notebook',
            async (client) =>
              toolResult(
                'ask_user_question',
                await client.callTool({
                  name: 'ask_user_question',
                  arguments: {
                    questions: [
                      {
                        header: 'Scope',
                        question: 'Which evidence scope should the researcher use?',
                        options: [
                          { label: 'Focused', description: 'Use the primary cohort only.' },
                          { label: 'Broad', description: 'Include exploratory cohorts.' }
                        ]
                      },
                      {
                        header: 'Format',
                        question: 'Which result format should the researcher return?',
                        options: [
                          { label: 'Table', description: 'Return a compact table.' },
                          { label: 'Narrative', description: 'Return concise prose.' }
                        ]
                      }
                    ]
                  }
                })
              )
          )
          if (asked.action !== 'pending') {
            throw new Error(`Delegated question was not parked: ${JSON.stringify(asked)}`)
          }
          reply = 'Delegated question requested.'
        } else if (prompt.includes('The user answered your delegated questions:')) {
          if (prompt.includes('Answer: Footnotes')) {
            reply = 'Delegated citation continuation completed.'
          } else if (!prompt.includes('Answer: Focused') || !prompt.includes('Answer: Narrative')) {
            throw new Error(`Delegated answers did not reach the continuation: ${prompt}`)
          } else {
            reply = 'Delegated answer continuation completed.'
          }
        } else if (prompt.includes(PERMISSION_PROMPT)) {
          const permission = await context.client.request(
            acp.methods.client.session.requestPermission,
            {
              sessionId: context.params.sessionId,
              toolCall: {
                toolCallId: 'e2e-permission-tool',
                title: 'Write fixture output'
              },
              options: [
                { kind: 'allow_once', name: 'Allow once', optionId: 'allow-once' },
                { kind: 'reject_once', name: 'Deny', optionId: 'deny-once' }
              ]
            }
          )
          reply =
            permission.outcome.outcome === 'selected' &&
            permission.outcome.optionId === 'allow-once'
              ? 'Fixture permission allowed.'
              : 'Fixture permission denied.'
        } else if (prompt.includes(SKILL_PERMISSION_PROMPT)) {
          // The broker classifies mcp__skills__load_skill via the legacy Claude prefix into
          // mcpIdentity 'skills/load_skill' without any server configuration.
          const permission = await context.client.request(
            acp.methods.client.session.requestPermission,
            {
              sessionId: context.params.sessionId,
              toolCall: {
                toolCallId: 'e2e-skill-permission-tool',
                title: 'mcp__skills__load_skill',
                rawInput: { skill: 'fixture-skill' }
              },
              options: [
                { kind: 'allow_once', name: 'Allow once', optionId: 'allow-once' },
                { kind: 'reject_once', name: 'Deny', optionId: 'deny-once' }
              ]
            }
          )
          reply =
            permission.outcome.outcome === 'selected' &&
            permission.outcome.optionId === 'allow-once'
              ? 'Fixture skill permission allowed.'
              : 'Fixture skill permission denied.'
        }
      } catch (error) {
        reply = `E2E fixture failure: ${error instanceof Error ? error.message : String(error)}`
      }

      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: `e2e-message-${nextMessageId++}`,
          content: { type: 'text', text: reply }
        }
      })

      return { stopReason: 'end_turn' }
    })
    .onNotification(acp.methods.agent.session.cancel, (context) => {
      const resolve = sessionCancellationResolvers.get(context.params.sessionId)
      sessionCancellationResolvers.delete(context.params.sessionId)
      resolve?.()
    })
    .onRequest(acp.methods.agent.session.close, () => ({}))

  const connection = app.connect(
    acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
  )
  await connection.closed
}
