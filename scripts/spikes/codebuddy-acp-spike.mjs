#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

// PROTOTYPE: disposable CodeBuddy ACP capability probe. It never uses ~/.codebuddy.
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const binary = process.env.CODEBUDDY_BIN || 'codebuddy'
const useMockProvider = process.argv.includes('--mock-provider')
const enableSkillTool = process.argv.includes('--enable-skill-tool')
const useAppSkillLoader = process.argv.includes('--app-skill-loader')
const resumeWithMcp = process.argv.includes('--resume-with-mcp')
const resumeBeforePrompt = process.argv.includes('--resume-before-prompt') || resumeWithMcp
const runCapabilityMatrix = process.argv.includes('--capability-matrix')
const runEffortProbe = process.argv.includes('--effort-probe')
const emitContentBeforeTool = process.argv.includes('--content-before-tool')
const registerMockModel = process.argv.includes('--register-mock-model')
const registerMockReasoningModel = process.argv.includes('--mock-reasoning-model')
const replaceSystemPrompt = process.argv.includes('--replace-system-prompt')
const useSystemPromptFile = process.argv.includes('--system-prompt-file')
const disableKnownNativeSkills = process.argv.includes('--disable-known-native-skills')
const cleanCwdAddProject = process.argv.includes('--clean-cwd-add-project')
const injectAllowedSessionSkill = process.argv.includes('--inject-allowed-session-skill')
const probeAddDirRead = process.argv.includes('--probe-add-dir-read')
const runImagePathProbe = process.argv.includes('--image-path-probe')
const runImageTransportMatrix = process.argv.includes('--image-transport-matrix')
const registerMockTextOnlyModel = process.argv.includes('--mock-text-only-model')
const runNetworkSandboxProbe = process.argv.includes('--network-sandbox-probe')
const mockBasePath = process.env.CODEBUDDY_SPIKE_BASE_PATH || ''
const mockModel = process.env.CODEBUDDY_SPIKE_MODEL || 'spike-model'
const root = await mkdtemp(join(tmpdir(), 'open-science-codebuddy-spike-'))
const configDir = join(root, 'config')
const projectDir = join(root, 'project')
const runtimeCwd = cleanCwdAddProject ? join(root, 'clean-cwd') : projectDir
const skillDir = join(projectDir, '.codebuddy', 'skills', 'project-sentinel')
const unknownSkillDir = join(projectDir, '.codebuddy', 'skills', 'unknown-project-sentinel')
const allowedSkillRoot = join(root, 'allowed-session-skills')
const allowedSkillDir = join(allowedSkillRoot, 'allowed-session-sentinel')
const projectAccessPath = join(projectDir, 'project-access-sentinel.txt')
const mockMcpPath = join(root, 'mock-mcp.mjs')
const systemPromptPath = join(root, 'system-prompt.md')
const mockSkillTool = {
  name: 'load_skill',
  description: 'Load mcp-pubmed through the isolated app-owned Skill runtime.',
  inputSchema: {
    type: 'object',
    properties: { skill: { type: 'string', const: 'mcp-pubmed' } },
    required: ['skill'],
    additionalProperties: false
  }
}
const mockNotebookTool = {
  name: 'repl_execute',
  description: 'Execute JavaScript with app-owned host.mcp Connector access.',
  inputSchema: {
    type: 'object',
    properties: { code: { type: 'string' } },
    required: ['code'],
    additionalProperties: false
  }
}
const mockPingTool = {
  name: 'ping',
  description: 'MCP_STDIO_SENTINEL',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false }
}

await mkdir(configDir, { recursive: true })
await Promise.all([
  mkdir(skillDir, { recursive: true }),
  mkdir(unknownSkillDir, { recursive: true }),
  mkdir(allowedSkillDir, { recursive: true })
])
await mkdir(runtimeCwd, { recursive: true })
await writeFile(
  join(configDir, 'settings.json'),
  `${JSON.stringify({
    model: 'user-sentinel-model',
    cleanupPeriodDays: 7,
    autoCompactEnabled: false,
    permissions: { deny: ['WebFetch', 'WebSearch'] },
    sandbox: {
      enabled: process.platform !== 'win32',
      autoAllowBashIfSandboxed: false,
      excludedCommands: [],
      allowUnsandboxedCommands: false,
      network: { allowUnixSockets: [], allowLocalBinding: false }
    },
    ...(disableKnownNativeSkills
      ? { skillOverrides: { 'project-sentinel': 'off', loop: 'off' } }
      : {})
  })}\n`
)
await writeFile(
  join(projectDir, '.codebuddy', 'settings.json'),
  '{"model":"project-sentinel-model"}\n'
)
await writeFile(
  join(projectDir, '.mcp.json'),
  '{"mcpServers":{"project-sentinel":{"command":"printf","args":["sentinel"]}}}\n'
)
await writeFile(
  join(skillDir, 'SKILL.md'),
  '---\nname: project-sentinel\ndescription: Must never cross an isolated host boundary.\n---\n\nSentinel.\n'
)
await writeFile(
  join(unknownSkillDir, 'SKILL.md'),
  '---\nname: unknown-project-sentinel\ndescription: UNLISTED_PROJECT_SKILL_SENTINEL\n---\n\nUnknown sentinel.\n'
)
await writeFile(
  join(allowedSkillDir, 'SKILL.md'),
  '---\nname: allowed-session-sentinel\ndescription: ALLOWED_SESSION_SKILL_SENTINEL\n---\n\nAllowed sentinel.\n'
)
await writeFile(projectAccessPath, 'PROJECT_FILE_ACCESS_SENTINEL\n')
await writeFile(systemPromptPath, 'SYSTEM_PROMPT_SENTINEL: app-owned instruction.\n')
await writeFile(
  mockMcpPath,
  `let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  const lines = buffer.split('\\n')
  buffer = lines.pop() || ''
  for (const line of lines) {
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.id === undefined) continue
    let result
    if (message.method === 'initialize') {
      result = {
        protocolVersion: message.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'codebuddy-spike-mcp', version: '0.0.0' }
      }
    } else if (message.method === 'tools/list') {
      result = {
        tools: [process.env.SPIKE_MCP_ROLE === 'skills'
          ? ${JSON.stringify(mockSkillTool)}
          : process.env.SPIKE_MCP_ROLE === 'notebook'
            ? ${JSON.stringify(mockNotebookTool)}
            : ${JSON.stringify(mockPingTool)}]
      }
    } else if (message.method === 'tools/call' && message.params?.name === 'load_skill') {
      result = {
        content: [{
          type: 'text',
          text: 'PUBMED_SKILL_SENTINEL: use await host.mcp("pubmed", "search_articles", {...}).'
        }]
      }
    } else if (message.method === 'tools/call' && message.params?.name === 'repl_execute') {
      result = {
        content: [{
          type: 'text',
          text: 'PUBMED_MCP_RESULT_SENTINEL: connector route completed.'
        }]
      }
    } else {
      result = {}
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
  }
})
`
)

const sessionMcpServers =
  runCapabilityMatrix || useAppSkillLoader
    ? useAppSkillLoader
      ? [
          {
            name: 'skills',
            command: process.execPath,
            args: [mockMcpPath],
            env: [{ name: 'SPIKE_MCP_ROLE', value: 'skills' }]
          },
          {
            name: 'open-science-notebook',
            command: process.execPath,
            args: [mockMcpPath],
            env: [{ name: 'SPIKE_MCP_ROLE', value: 'notebook' }]
          }
        ]
      : [
          {
            name: 'spike_stdio',
            command: process.execPath,
            args: [mockMcpPath],
            env: []
          }
        ]
    : []

const isolatedEnv = {
  ...process.env,
  CODEBUDDY_CONFIG_DIR: configDir,
  CODEBUDDY_SKIP_BUILTIN_MARKETPLACE: '1',
  CODEBUDDY_DISABLE_HOT_RELOAD: '1',
  CODEBUDDY_DISABLE_AUTO_MEMORY: '1',
  CODEBUDDY_CODE_DISABLE_AUTO_MEMORY: '1',
  CODEBUDDY_DISABLE_FORK_SUBAGENT: '1',
  CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: '1',
  CODEBUDDY_DEFER_TOOL_LOADING: '0',
  ...(injectAllowedSessionSkill ? { CODEBUDDY_SESSION_SKILL_DIRS: allowedSkillRoot } : {}),
  DISABLE_TELEMETRY: '1',
  NO_BROWSER: '1'
}

const mockRequests = []
let permissionToolCallIssued = false
let networkToolCallIssued = false
let skillLoaderToolCallIssued = false
let connectorMcpToolCallIssued = false
let readToolCallIssued = false
let observeCancelRequest
const cancelRequestObserved = new Promise((resolveObserved) => {
  observeCancelRequest = resolveObserved
})
let mockServer
if (useMockProvider) {
  mockServer = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      let parsedBody
      try {
        parsedBody = JSON.parse(body)
      } catch {
        parsedBody = body
      }
      const serializedBody = JSON.stringify(parsedBody)
      const cancelProbe = serializedBody.includes('CANCEL_PROBE')
      const permissionProbe = serializedBody.includes('PERMISSION_PROBE')
      const networkProbe = serializedBody.includes('NETWORK_SANDBOX_PROBE')
      if (cancelProbe) observeCancelRequest()
      const toolNames = Array.isArray(parsedBody?.tools)
        ? parsedBody.tools
            .map((tool) => tool?.function?.name || tool?.name)
            .filter((name) => typeof name === 'string')
        : []
      const skillTool = Array.isArray(parsedBody?.tools)
        ? parsedBody.tools.find((tool) => (tool?.function?.name || tool?.name) === 'Skill')
        : undefined
      const systemLikeMessages = Array.isArray(parsedBody?.messages)
        ? parsedBody.messages.filter(
            (message) => message?.role === 'system' || message?.role === 'developer'
          )
        : []
      const systemLikeText = systemLikeMessages
        .map((message) =>
          typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
        )
        .join('\n')
      const imageLocalPaths = [
        ...serializedBody.matchAll(/<image_local_path>(.*?)<\/image_local_path>/g)
      ].map((match) => match[1])
      const imageTransportMessage = Array.isArray(parsedBody?.messages)
        ? parsedBody.messages.find(
            (message) =>
              message?.role === 'user' &&
              JSON.stringify(message.content).includes('IMAGE_TRANSPORT_')
          )
        : undefined
      const imageTransportParts = Array.isArray(imageTransportMessage?.content)
        ? imageTransportMessage.content.map((part) => ({
            type: part?.type,
            value:
              typeof part?.text === 'string' && part.text.includes('<image_local_path>')
                ? 'synthetic-local-path'
                : typeof part?.text === 'string' && part.text.includes('IMAGE_TRANSPORT_')
                  ? 'case-marker'
                  : typeof part?.image_url?.url === 'string' &&
                      part.image_url.url.startsWith('data:image/')
                    ? 'base64-data-url'
                    : 'other'
          }))
        : []
      mockRequests.push({
        method: request.method,
        url: request.url,
        model: parsedBody?.model,
        requestKeys:
          parsedBody && typeof parsedBody === 'object' ? Object.keys(parsedBody).sort() : [],
        reasoningEffort: parsedBody?.reasoning_effort ?? parsedBody?.reasoningEffort,
        reasoningKeys:
          parsedBody?.reasoning && typeof parsedBody.reasoning === 'object'
            ? Object.keys(parsedBody.reasoning).sort()
            : [],
        thinkingKeys:
          parsedBody?.thinking && typeof parsedBody.thinking === 'object'
            ? Object.keys(parsedBody.thinking).sort()
            : [],
        messageCount: Array.isArray(parsedBody?.messages) ? parsedBody.messages.length : undefined,
        toolNames,
        skillToolDescription:
          skillTool?.function?.description ?? skillTool?.description ?? undefined,
        systemLikeMessageCount: systemLikeMessages.length,
        systemLikeTextLength: systemLikeText.length,
        systemLikeHasNonSentinelText:
          systemLikeText.replace('SYSTEM_PROMPT_SENTINEL: app-owned instruction.', '').trim()
            .length > 0,
        hasOriginalPrompt: serializedBody.includes('Write the integers from 1 to 200'),
        hasTurnInject: serializedBody.includes('Stop and reply exactly TURN_INJECT_OK.'),
        hasProjectSkillSentinel: serializedBody.includes('project-sentinel'),
        hasProjectSkillInstruction: serializedBody.includes(
          'Must never cross an isolated host boundary.'
        ),
        hasUnknownProjectSkill: serializedBody.includes('UNLISTED_PROJECT_SKILL_SENTINEL'),
        hasAllowedSessionSkill: serializedBody.includes('ALLOWED_SESSION_SKILL_SENTINEL'),
        hasProjectFileAccess: serializedBody.includes('PROJECT_FILE_ACCESS_SENTINEL'),
        hasImagePayload: /image_(?:url|data)|data:image\/png/.test(serializedBody),
        imageLocalPaths,
        imageTransportCase: [
          'IMAGE_TRANSPORT_INLINE_URI',
          'IMAGE_TRANSPORT_EMBEDDED_BLOB',
          'IMAGE_TRANSPORT_RESOURCE_LINK',
          'IMAGE_TRANSPORT_TEXT_ONLY',
          'IMAGE_TRANSPORT_INLINE'
        ].find((marker) => serializedBody.includes(marker)),
        hasInputImageUri: serializedBody.includes('file:///tmp/acp-input-uri.png'),
        hasResourceLinkUri: serializedBody.includes('file:///tmp/acp-resource-link.png'),
        hasEmbeddedBlobUri: serializedBody.includes('file:///tmp/acp-embedded-blob.png'),
        imageTransportParts,
        hasEmbeddedContext: serializedBody.includes('EMBEDDED_CONTEXT_SENTINEL'),
        hasSystemPromptSentinel: serializedBody.includes('SYSTEM_PROMPT_SENTINEL'),
        hasMcpStdioSentinel: serializedBody.includes('MCP_STDIO_SENTINEL'),
        hasLoadedPubMedSkill: serializedBody.includes('PUBMED_SKILL_SENTINEL'),
        hasPubMedMcpResult: serializedBody.includes('PUBMED_MCP_RESULT_SENTINEL'),
        hasCancelProbe: cancelProbe,
        hasPermissionProbe: permissionProbe,
        hasNetworkProbe: networkProbe,
        hasHighEffortProbe: serializedBody.includes('EFFORT_PROBE_HIGH'),
        hasDisabledEffortProbe: serializedBody.includes('EFFORT_PROBE_DISABLED'),
        isTitleRequest: serializedBody.includes('Generate a concise')
      })
      if (request.url?.endsWith('/count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"input_tokens":1}')
        return
      }
      const injected = serializedBody.includes('Stop and reply exactly TURN_INJECT_OK.')
      const isTitleRequest = serializedBody.includes('Generate a concise')
      const text = isTitleRequest
        ? '{"isNewTopic":true,"title":"Spike"}'
        : injected
          ? 'TURN_INJECT_OK'
          : 'FIRST_PASS'
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache'
      })
      const id = `chatcmpl-spike-${mockRequests.length}`
      const chunk = (delta, finishReason = null, usage) =>
        response.write(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created: 0,
            model: mockModel,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
            ...(usage ? { usage } : {})
          })}\n\n`
        )
      if (probeAddDirRead && toolNames.includes('Read') && !readToolCallIssued && !isTitleRequest) {
        readToolCallIssued = true
        chunk({ role: 'assistant', content: '' })
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_project_access_probe',
              type: 'function',
              function: {
                name: 'Read',
                arguments: JSON.stringify({ file_path: projectAccessPath })
              }
            }
          ]
        })
        chunk({}, 'tool_calls', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })
        response.end('data: [DONE]\n\n')
        return
      }
      if (
        useAppSkillLoader &&
        toolNames.includes('mcp__skills__load_skill') &&
        !skillLoaderToolCallIssued &&
        !isTitleRequest
      ) {
        skillLoaderToolCallIssued = true
        chunk({ role: 'assistant', content: '' })
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_load_pubmed_skill',
              type: 'function',
              function: {
                name: 'mcp__skills__load_skill',
                arguments: '{"skill":"mcp-pubmed"}'
              }
            }
          ]
        })
        chunk({}, 'tool_calls', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })
        response.end('data: [DONE]\n\n')
        return
      }
      if (
        useAppSkillLoader &&
        serializedBody.includes('PUBMED_SKILL_SENTINEL') &&
        toolNames.includes('mcp__open_science_notebook__repl_execute') &&
        !connectorMcpToolCallIssued &&
        !isTitleRequest
      ) {
        connectorMcpToolCallIssued = true
        chunk({ role: 'assistant', content: '' })
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_pubmed_connector',
              type: 'function',
              function: {
                name: 'mcp__open_science_notebook__repl_execute',
                arguments:
                  '{"code":"return await host.mcp(\\"pubmed\\", \\"search_articles\\", {query: \\"TP53 tumor\\"})"}'
              }
            }
          ]
        })
        chunk({}, 'tool_calls', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })
        response.end('data: [DONE]\n\n')
        return
      }
      if (networkProbe && toolNames.includes('Bash') && !networkToolCallIssued && !isTitleRequest) {
        networkToolCallIssued = true
        chunk({ role: 'assistant', content: '' })
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_network_sandbox_probe',
              type: 'function',
              function: {
                name: 'Bash',
                arguments:
                  '{"command":"curl --max-time 2 https://example.com/open-science-network-probe"}'
              }
            }
          ]
        })
        chunk({}, 'tool_calls', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })
        response.end('data: [DONE]\n\n')
        return
      }
      if (
        permissionProbe &&
        toolNames.includes('Bash') &&
        !permissionToolCallIssued &&
        !isTitleRequest
      ) {
        permissionToolCallIssued = true
        chunk({
          role: 'assistant',
          content: emitContentBeforeTool ? 'VISIBLE_BEFORE_TOOL_SENTINEL' : ''
        })
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_permission_probe',
              type: 'function',
              function: {
                name: 'Bash',
                arguments: '{"command":"printf CODEBUDDY_PERMISSION_PROBE"}'
              }
            }
          ]
        })
        chunk({}, 'tool_calls', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })
        response.end('data: [DONE]\n\n')
        return
      }
      const isLongRunningTurn = cancelProbe || (!injected && !isTitleRequest)
      chunk({ role: 'assistant', content: '' })
      setTimeout(() => chunk({ content: text }), isLongRunningTurn ? 1_000 : 50)
      setTimeout(
        () => {
          chunk({}, 'stop', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })
          response.end('data: [DONE]\n\n')
        },
        isLongRunningTurn ? 2_000 : 100
      )
    })
  })
  await new Promise((resolveListen) => mockServer.listen(0, '127.0.0.1', resolveListen))
  const address = mockServer.address()
  Object.assign(isolatedEnv, {
    CODEBUDDY_API_KEY: 'spike-local-only',
    CODEBUDDY_BASE_URL: `http://127.0.0.1:${address.port}${mockBasePath}`,
    CODEBUDDY_SPIKE_API_URL: `http://127.0.0.1:${address.port}${mockBasePath}/chat/completions`,
    CODEBUDDY_MODEL: mockModel
  })
  if (registerMockModel) {
    await writeFile(
      join(configDir, 'models.json'),
      `${JSON.stringify(
        {
          models: [
            {
              id: mockModel,
              name: mockModel,
              vendor: 'spike',
              apiKey: '${CODEBUDDY_API_KEY}',
              url: '${CODEBUDDY_SPIKE_API_URL}',
              maxInputTokens: 128_000,
              maxOutputTokens: 8_192,
              supportsToolCall: true,
              supportsImages: !registerMockTextOnlyModel,
              supportsReasoning: registerMockReasoningModel
            }
          ],
          availableModels: [mockModel]
        },
        null,
        2
      )}\n`
    )
  }
}

const run = (args, timeoutMs = 10_000) =>
  new Promise((resolveRun) => {
    const child = spawn(binary, args, {
      cwd: runtimeCwd,
      env: isolatedEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolveRun({ code, signal, stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })

const version = await run(['--version'])
const acpArgs = [
  '--acp',
  ...(runCapabilityMatrix ? [] : ['--no-session-persistence']),
  '--setting-sources',
  'user',
  '--strict-mcp-config',
  '--tools',
  enableSkillTool ? (probeAddDirRead ? 'Skill,Read' : 'Skill') : runCapabilityMatrix ? 'Bash' : '',
  ...(runNetworkSandboxProbe
    ? [
        '--disallowedTools',
        'Bash(curl:*)',
        'Bash(wget:*)',
        'Bash(ssh:*)',
        'Bash(git clone:*)',
        'Bash(git fetch:*)',
        'Bash(git pull:*)',
        'Bash(git push:*)'
      ]
    : []),
  ...(cleanCwdAddProject ? ['--add-dir', projectDir] : []),
  ...(runCapabilityMatrix
    ? useSystemPromptFile
      ? ['--system-prompt-file', systemPromptPath]
      : [
          replaceSystemPrompt ? '--system-prompt' : '--append-system-prompt',
          'SYSTEM_PROMPT_SENTINEL: app-owned instruction.'
        ]
    : [])
]

let nextId = 1
let stdoutBuffer = ''
let stderr = ''
const pending = new Map()
const notifications = []
const clientRequests = []

const startAcpChild = () => {
  const process = spawn(binary, acpArgs, {
    cwd: runtimeCwd,
    env: isolatedEnv,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  process.stderr.on('data', (chunk) => (stderr += chunk))
  process.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString().replaceAll('\0', '')
    const lines = stdoutBuffer.split('\n')
    stdoutBuffer = lines.pop() || ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (
        message.id !== undefined &&
        (message.result !== undefined || message.error !== undefined)
      ) {
        const waiter = pending.get(message.id)
        if (waiter) {
          pending.delete(message.id)
          waiter(message)
        }
      } else if (message.method && message.id !== undefined) {
        clientRequests.push(message)
        if (message.method === 'fs/read_text_file' && message.params?.path === projectAccessPath) {
          void readFile(projectAccessPath, 'utf8').then((content) => {
            process.stdin.write(
              `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content } })}\n`
            )
          })
          continue
        }
        const allowOnce = message.params?.options?.find(
          (option) => option.kind === 'allow_once' || option.optionId === 'allow'
        )
        const result =
          message.method === 'session/request_permission' && allowOnce
            ? { outcome: { outcome: 'selected', optionId: allowOnce.optionId } }
            : undefined
        process.stdin.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            ...(result
              ? { result }
              : {
                  error: {
                    code: -32601,
                    message:
                      message.method === '_codebuddy.ai/authUrl'
                        ? 'Authentication is disabled in this spike'
                        : `Spike client does not implement ${message.method}`
                  }
                })
          })}\n`
        )
      } else if (message.method) {
        notifications.push(message)
      }
    }
  })
  return process
}

let child = startAcpChild()

const request = (method, params, timeoutMs = 10_000) =>
  new Promise((resolveRequest) => {
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(id)
      resolveRequest({ timeout: true })
    }, timeoutMs)
    pending.set(id, (message) => {
      clearTimeout(timer)
      resolveRequest(message)
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })

const notify = (method, params) =>
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)

const initialize = await request('initialize', {
  protocolVersion: 1,
  clientInfo: { name: 'open-science-codebuddy-spike', version: '0.0.0' },
  clientCapabilities: {
    fs: { readTextFile: true, writeTextFile: true },
    session: { configOptions: { boolean: {} } },
    plan: {},
    elicitation: { form: {} }
  }
})
const sessionSteer = await request('session/steer', {
  sessionId: 'missing-session',
  contentBlocks: [{ type: 'text', text: 'sentinel' }]
})
const underscoreSteering = await request('_session/steering', {
  sessionId: 'missing-session',
  prompt: [{ type: 'text', text: 'sentinel' }]
})
const enqueueFollowup = await request('session/enqueue_followup', {
  sessionId: 'missing-session',
  contentBlocks: [{ type: 'text', text: 'sentinel' }]
})

const newSession = await request('session/new', {
  cwd: runtimeCwd,
  mcpServers: sessionMcpServers
})
let idleSteer
let staleSteer
let liveSteer
let prompt
let prePromptResume
let capabilityMatrix
let effortProbe
if (newSession.result?.sessionId) {
  const sessionId = newSession.result.sessionId
  if (resumeBeforePrompt) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
    prePromptResume = await request('session/resume', {
      sessionId,
      cwd: runtimeCwd,
      ...(resumeWithMcp ? { mcpServers: sessionMcpServers } : {})
    })
  }
  idleSteer = await request('session/steer', {
    sessionId,
    contentBlocks: [{ type: 'text', text: 'idle sentinel' }]
  })
  const promptPromise = request(
    'session/prompt',
    {
      sessionId,
      prompt: [
        {
          type: 'text',
          text: 'Write the integers from 1 to 200, one per line. Do not stop early.'
        }
      ]
    },
    180_000
  )
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 300))
  staleSteer = await request('session/steer', {
    sessionId,
    expectedRequestId: 'definitely-stale',
    contentBlocks: [{ type: 'text', text: 'stale sentinel' }]
  })
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
  liveSteer = await request('session/steer', {
    sessionId,
    contentBlocks: [{ type: 'text', text: 'Stop and reply exactly TURN_INJECT_OK.' }]
  })
  prompt = await promptPromise

  if (runImagePathProbe) {
    await request(
      'session/prompt',
      {
        sessionId,
        prompt: [
          { type: 'text', text: 'Describe the supplied image briefly.' },
          {
            type: 'image',
            mimeType: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
          }
        ]
      },
      30_000
    )
  }

  if (runImageTransportMatrix) {
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const cases = [
      {
        marker: 'IMAGE_TRANSPORT_INLINE',
        block: { type: 'image', mimeType: 'image/png', data: png }
      },
      {
        marker: 'IMAGE_TRANSPORT_INLINE_URI',
        block: {
          type: 'image',
          mimeType: 'image/png',
          data: png,
          uri: 'file:///tmp/acp-input-uri.png'
        }
      },
      {
        marker: 'IMAGE_TRANSPORT_EMBEDDED_BLOB',
        block: {
          type: 'resource',
          resource: {
            uri: 'file:///tmp/acp-embedded-blob.png',
            mimeType: 'image/png',
            blob: png
          }
        }
      },
      {
        marker: 'IMAGE_TRANSPORT_RESOURCE_LINK',
        block: {
          type: 'resource_link',
          uri: 'file:///tmp/acp-resource-link.png',
          name: 'acp-resource-link.png',
          mimeType: 'image/png'
        }
      },
      { marker: 'IMAGE_TRANSPORT_TEXT_ONLY' }
    ]
    for (const transportCase of cases) {
      const isolatedSession = await request('session/new', {
        cwd: runtimeCwd,
        mcpServers: []
      })
      if (!isolatedSession.result?.sessionId) continue
      await request(
        'session/prompt',
        {
          sessionId: isolatedSession.result.sessionId,
          prompt: [
            { type: 'text', text: transportCase.marker },
            ...(transportCase.block ? [transportCase.block] : [])
          ]
        },
        30_000
      )
    }
  }

  if (runEffortProbe) {
    const high = await request('session/set_config_option', {
      sessionId,
      configId: 'thought_level',
      value: 'high'
    })
    await request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: 'EFFORT_PROBE_HIGH' }] },
      30_000
    )
    const disabled = await request('session/set_config_option', {
      sessionId,
      configId: 'thought_level',
      value: 'disabled'
    })
    await request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: 'EFFORT_PROBE_DISABLED' }] },
      30_000
    )
    effortProbe = { high, disabled }
  }

  if (runCapabilityMatrix) {
    const setMode = await request('session/set_mode', { sessionId, modeId: 'plan' })
    const setThoughtLevel = await request('session/set_config_option', {
      sessionId,
      configId: 'thought_level',
      value: 'disabled'
    })
    const setModelConfig = await request('session/set_config_option', {
      sessionId,
      configId: 'model',
      value: mockModel
    })
    const setModel = await request('session/set_model', { sessionId, modelId: mockModel })
    const multimodalPrompt = await request(
      'session/prompt',
      {
        sessionId,
        prompt: [
          { type: 'text', text: 'Describe the supplied image and embedded context briefly.' },
          {
            type: 'image',
            mimeType: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
          },
          {
            type: 'resource',
            resource: {
              uri: 'file:///spike/context.txt',
              mimeType: 'text/plain',
              text: 'EMBEDDED_CONTEXT_SENTINEL'
            }
          }
        ]
      },
      30_000
    )
    const cancelPromise = request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: 'CANCEL_PROBE: keep streaming.' }] },
      30_000
    )
    await Promise.race([
      cancelRequestObserved,
      new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000))
    ])
    notify('session/cancel', { sessionId })
    const cancelledPrompt = await cancelPromise
    const setDelegateMode = await request('session/set_mode', {
      sessionId,
      modeId: 'delegate'
    })
    const permissionPrompt = await request(
      'session/prompt',
      {
        sessionId,
        prompt: [
          {
            type: 'text',
            text: 'PERMISSION_PROBE: call Bash to print CODEBUDDY_PERMISSION_PROBE.'
          }
        ]
      },
      30_000
    )
    const networkSandboxPrompt = runNetworkSandboxProbe
      ? await request(
          'session/prompt',
          {
            sessionId,
            prompt: [
              {
                type: 'text',
                text: 'NETWORK_SANDBOX_PROBE: call Bash with the requested curl command.'
              }
            ]
          },
          30_000
        )
      : undefined
    const compactRequestCountBefore = mockRequests.length
    const compactPrompt = await request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: '/compact' }] },
      30_000
    )
    const compactRequestCountAfter = mockRequests.length
    const providersList = await request('providers/list', {}, 30_000)
    const list = await request('session/list', { cwd: runtimeCwd }, 30_000)
    const load = await request(
      'session/load',
      { sessionId, cwd: runtimeCwd, mcpServers: sessionMcpServers },
      30_000
    )
    const resume = await request(
      'session/resume',
      { sessionId, cwd: runtimeCwd, mcpServers: sessionMcpServers },
      30_000
    )
    const fork = await request(
      'session/fork',
      { sessionId, cwd: runtimeCwd, mcpServers: [] },
      30_000
    )
    const forkSessionId = fork.result?.sessionId
    const closeFork = forkSessionId
      ? await request('session/close', { sessionId: forkSessionId }, 30_000)
      : undefined
    const close = await request('session/close', { sessionId }, 30_000)
    const deleteSession = await request('session/delete', { sessionId }, 30_000)
    capabilityMatrix = {
      setMode,
      setThoughtLevel,
      setModelConfig,
      setModel,
      multimodalPrompt,
      cancelledPrompt,
      compactPrompt,
      compactModelRequestCount: compactRequestCountAfter - compactRequestCountBefore,
      setDelegateMode,
      permissionPrompt,
      networkSandboxPrompt,
      providersList,
      list,
      load,
      resume,
      fork,
      closeFork,
      close,
      deleteSession
    }
  }
}
const stopChild = async () => {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolveClose) => {
    child.once('close', resolveClose)
    child.kill('SIGTERM')
  })
}

if (runCapabilityMatrix && newSession.result?.sessionId) {
  await stopChild()
  stdoutBuffer = ''
  child = startAcpChild()
  const restartInitialize = await request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'open-science-codebuddy-spike-restart', version: '0.0.0' },
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      session: { configOptions: { boolean: {} } },
      plan: {},
      elicitation: { form: {} }
    }
  })
  const crossProcessResume = await request(
    'session/resume',
    {
      sessionId: newSession.result.sessionId,
      cwd: runtimeCwd,
      mcpServers: sessionMcpServers
    },
    30_000
  )
  const resumedPrompt = crossProcessResume.result
    ? await request(
        'session/prompt',
        {
          sessionId: newSession.result.sessionId,
          prompt: [{ type: 'text', text: 'Reply briefly after cross-process resume.' }]
        },
        30_000
      )
    : undefined
  capabilityMatrix.restartInitialize = restartInitialize
  capabilityMatrix.crossProcessResume = crossProcessResume
  capabilityMatrix.resumedPrompt = resumedPrompt
}
await stopChild()
if (mockServer) await new Promise((resolveClose) => mockServer.close(resolveClose))

let packageScan = { available: false }
try {
  const resolvedBinary = await realpath(binary)
  const packageRoot = resolve(dirname(resolvedBinary), '..')
  const source = await readFile(join(packageRoot, 'dist', 'codebuddy-headless.js'), 'utf8')
  packageScan = {
    available: true,
    sessionSteer: source.includes('session/steer'),
    underscoreSteering: source.includes('_session/steering'),
    projectSkillDiscovery: source.includes('getProjectSkillsDir()'),
    userSkillDiscovery: source.includes('getHomeSkillsDir()'),
    additiveSessionSkillDirs: source.includes('CODEBUDDY_SESSION_SKILL_DIRS'),
    disableExternalSkillsSwitch: source.includes('CODEBUDDY_DISABLE_EXTERNAL_SKILLS'),
    projectModelsWatcher: source.includes('models.json') && source.includes('projectConfigWatcher'),
    untrustedHooksDefaultOff: source.includes('allowUntrustedFrontmatterHooks')
  }
} catch {
  // The protocol probes still run when the executable is not an npm package with readable sources.
}

const errorCode = (response) => response?.error?.code
const errorText = (response) => response?.error?.data || response?.error?.message
const authMethodIds = initialize.result?.authMethods?.map((method) => method.id) ?? []
const compactProbe = (response) => {
  if (typeof response === 'number') return response
  if (!response) return undefined
  if (response.timeout) return { ok: false, timeout: true }
  if (response.error) {
    return {
      ok: false,
      code: response.error.code,
      message: response.error.message,
      data: response.error.data
    }
  }
  const value = response.result
  if (!value || typeof value !== 'object') return { ok: true, result: value }
  return {
    ok: true,
    sessionId: value.sessionId,
    modeId: value.modeId,
    currentModelId: value.models?.currentModelId,
    sessionCount: Array.isArray(value.sessions) ? value.sessions.length : undefined,
    stopReason: value.stopReason,
    configValues: Array.isArray(value.configOptions)
      ? Object.fromEntries(value.configOptions.map((option) => [option.id, option.currentValue]))
      : undefined
  }
}
const result = {
  question:
    'Can CodeBuddy be added as an isolated ACP framework with live turn injection and app-owned skills?',
  tempRoot: root,
  version: version.stdout,
  protocol: {
    initialize: {
      protocolVersion: initialize.result?.protocolVersion,
      agentCapabilities: initialize.result?.agentCapabilities,
      authMethodIds
    },
    sessionSteerRegistered: errorCode(sessionSteer) !== -32601,
    sessionSteerProbe: errorText(sessionSteer) || sessionSteer.result,
    underscoreSteeringRegistered: errorCode(underscoreSteering) !== -32601,
    underscoreSteeringProbe: errorText(underscoreSteering) || underscoreSteering.result,
    enqueueFollowupRegistered: errorCode(enqueueFollowup) !== -32601,
    enqueueFollowupProbe: errorText(enqueueFollowup) || enqueueFollowup.result,
    newSession: {
      created: Boolean(newSession.result?.sessionId),
      sessionId: newSession.result?.sessionId,
      currentModelId: newSession.result?.models?.currentModelId,
      models: newSession.result?.models,
      configOptions: newSession.result?.configOptions,
      error: errorText(newSession)
    },
    authenticateCalled: false,
    authUrlRequested: clientRequests.some((entry) => entry.method === '_codebuddy.ai/authUrl'),
    idleSteer: idleSteer && (errorText(idleSteer) || idleSteer.result),
    staleSteer: staleSteer && (errorText(staleSteer) || staleSteer.result),
    liveSteer: liveSteer && (errorText(liveSteer) || liveSteer.result),
    prompt: prompt && (errorText(prompt) || prompt.result),
    prePromptResume: prePromptResume && (errorText(prePromptResume) || prePromptResume.result),
    effortProbe: effortProbe && {
      high: compactProbe(effortProbe.high),
      disabled: compactProbe(effortProbe.disabled)
    },
    effortProbeRequests: mockRequests
      .filter((entry) => entry.hasHighEffortProbe || entry.hasDisabledEffortProbe)
      .map((entry) => ({
        high: entry.hasHighEffortProbe,
        disabled: entry.hasDisabledEffortProbe,
        requestKeys: entry.requestKeys,
        reasoningEffort: entry.reasoningEffort,
        reasoningKeys: entry.reasoningKeys,
        thinkingKeys: entry.thinkingKeys
      })),
    capabilityMatrix:
      capabilityMatrix &&
      Object.fromEntries(
        Object.entries(capabilityMatrix).map(([name, response]) => [name, compactProbe(response)])
      ),
    turnInjectMarkerObserved: notifications.some((entry) =>
      JSON.stringify(entry).includes('TURN_INJECT_OK')
    ),
    mockRequests,
    imageTransportMatrix: mockRequests
      .filter((entry) => entry.imageTransportCase && !entry.isTitleRequest)
      .map((entry) => ({
        case: entry.imageTransportCase,
        hasImagePayload: entry.hasImagePayload,
        hasInputImageUri: entry.hasInputImageUri,
        hasResourceLinkUri: entry.hasResourceLinkUri,
        hasEmbeddedBlobUri: entry.hasEmbeddedBlobUri,
        providerParts: entry.imageTransportParts,
        imageLocalPathCount: entry.imageLocalPaths.length,
        imageLocalPaths: entry.imageLocalPaths
      })),
    notificationMethods: [...new Set(notifications.map((entry) => entry.method))],
    sessionUpdateKinds: [
      ...new Set(
        notifications
          .filter((entry) => entry.method === 'session/update')
          .map((entry) => entry.params?.update?.sessionUpdate)
          .filter(Boolean)
      )
    ],
    sessionUpdateTrace: notifications
      .filter(
        (entry) =>
          entry.method === 'session/update' &&
          ['agent_message_chunk', 'usage_update', 'tool_call', 'tool_call_update'].includes(
            entry.params?.update?.sessionUpdate
          )
      )
      .map((entry) => ({
        kind: entry.params.update.sessionUpdate,
        messageId: entry.params.update.messageId,
        toolCallId: entry.params.update.toolCallId,
        status: entry.params.update.status,
        textLength:
          entry.params.update.content?.type === 'text'
            ? entry.params.update.content.text?.length
            : undefined
      })),
    usageUpdates: notifications
      .filter(
        (entry) =>
          entry.method === 'session/update' &&
          entry.params?.update?.sessionUpdate === 'usage_update'
      )
      .map((entry) => entry.params.update),
    appSkillLoaderToolObserved: mockRequests.some((entry) =>
      entry.toolNames.includes('mcp__skills__load_skill')
    ),
    appSkillDocumentObserved: mockRequests.some((entry) => entry.hasLoadedPubMedSkill),
    connectorMcpToolObserved: mockRequests.some((entry) =>
      entry.toolNames.includes('mcp__open_science_notebook__repl_execute')
    ),
    connectorMcpResultObserved: mockRequests.some((entry) => entry.hasPubMedMcpResult),
    permissionRequests: clientRequests
      .filter((entry) => entry.method === 'session/request_permission')
      .map((entry) => entry.params),
    clientRequestMethods: [...new Set(clientRequests.map((entry) => entry.method))]
  },
  isolation: {
    skillToolEnabled: enableSkillTool,
    disableKnownNativeSkills,
    cleanCwdAddProject,
    injectAllowedSessionSkill,
    probeAddDirRead,
    runtimeCwd,
    configDir: configDir,
    packageScan
  },
  stderr: stderr.trim()
}

console.log(
  JSON.stringify(
    runImageTransportMatrix
      ? {
          version: result.version,
          agentPromptCapabilities: result.protocol.initialize.agentCapabilities?.promptCapabilities,
          currentModel: result.protocol.newSession.models?.availableModels?.[0],
          imageTransportMatrix: result.protocol.imageTransportMatrix,
          authenticateCalled: result.protocol.authenticateCalled,
          authUrlRequested: result.protocol.authUrlRequested
        }
      : result,
    null,
    2
  )
)

if (runImagePathProbe && mockRequests.some((entry) => entry.imageLocalPaths.length > 0)) {
  process.exitCode = 1
}
