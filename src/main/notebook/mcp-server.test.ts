import { Client as ModelContextProtocolClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import { Tiktoken } from 'js-tiktoken/lite'
import cl100kBase from 'js-tiktoken/ranks/cl100k_base'
import { z } from 'zod'

import { HOST_SDK_SUBAGENT_OPERATION_IDS, hostSdkHelp } from '../host-sdk/help'
import {
  memoryAgentRememberMcpOutputSchema,
  memoryAgentRememberRequestSchema,
  memoryAgentSearchRequestSchema
} from '../../shared/memory'

// Transport behavior has dedicated integration coverage. Keep this MCP suite on the observable
// fetch boundary so long-running tool calls can be completed deterministically with fake timers.
vi.mock('../local-rpc-transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../local-rpc-transport')>()
  return {
    ...actual,
    fetchLongLivedLocalRpc: async function fetchLongLivedLocalRpc(
      ...args: Parameters<typeof actual.fetchLocalRpc>
    ): ReturnType<typeof actual.fetchLocalRpc> {
      return actual.fetchLocalRpc(...args)
    }
  }
})

import {
  BASH_EXECUTE_DOC,
  buildShellExecuteDoc,
  INSPECT_PACKAGES_DOC,
  MANAGE_ENVIRONMENTS_DOC,
  MANAGE_PACKAGES_DOC,
  NOTEBOOK_MCP_CONTROL_RESULT_LIMIT,
  NOTEBOOK_MCP_EXECUTION_RESULT_LIMIT,
  NOTEBOOK_MCP_STATE_RESULT_LIMIT,
  REPL_EXECUTE_DOC,
  NOTEBOOK_RPC_TOOLS,
  NOTEBOOK_SYSTEM_PROMPT_APPEND,
  callNotebookRpc,
  buildNotebookToolContent,
  compactNotebookExecutionResult,
  compactNotebookStateResult,
  compactManagePackagesResult,
  compactInspectPackagesResult,
  compactListRuntimesResult,
  compactManageEnvironmentsResult,
  compactRuntimeBindingResult,
  compactShutdownResult,
  compactRestartResult,
  createNotebookMcpEnvironmentFromProcess,
  createNotebookMcpServer,
  createNotebookMcpServerConfig,
  notebookRpcToolsForEnvironment,
  resolveNotebookRpcFetch,
  serializeNotebookToolResult
} from './mcp-server'

const tokenizer = new Tiktoken(cl100kBase)

const rememberMemoryArguments = {
  content: 'Use channel A for this project.',
  analysis: {
    scope: 'project' as const,
    durability: 'cross-session' as const,
    evidence: 'project-observed' as const,
    subject: 'Microscopy channel',
    reason: 'Future sessions need the working channel.'
  }
}

const callRememberMemoryThroughMcp = async (
  rpcResult: Record<string, unknown>
): Promise<{
  result: Awaited<ReturnType<ModelContextProtocolClient['callTool']>>
  rpcCallCount: number
}> => {
  const environment = {
    endpoint: 'http://127.0.0.1:4567',
    token: 'secret-token',
    projectId: 'project-1',
    sessionId: 'session-1',
    workspaceCwd: '/workspace',
    memoryTools: true
  }
  const server = createNotebookMcpServer(environment)
  const client = new ModelContextProtocolClient({ name: 'notebook-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const originalFetch = globalThis.fetch
  const fetchRpc = vi.fn(
    async () =>
      ({
        ok: true,
        json: async () => ({ result: rpcResult })
      }) as Response
  )
  globalThis.fetch = fetchRpc as typeof fetch

  try {
    const result = await client.callTool({
      name: 'remember_memory',
      arguments: rememberMemoryArguments
    })
    return { result, rpcCallCount: fetchRpc.mock.calls.length }
  } finally {
    globalThis.fetch = originalFetch
    await client.close()
    await server.close()
  }
}

describe('notebook MCP server config', () => {
  it('builds an ACP stdio MCP server config scoped to the notebook runtime RPC endpoint', () => {
    const config = createNotebookMcpServerConfig({
      command: '/Applications/Open Science.app/Contents/MacOS/Open Science',
      entryPath: '/app/out/main/index.js',
      endpoint: 'http://127.0.0.1:4567',
      token: 'secret-token',
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      memoryTools: true
    })

    expect(config).toEqual({
      name: 'open-science-notebook',
      command: '/Applications/Open Science.app/Contents/MacOS/Open Science',
      args: ['/app/out/main/index.js', '--open-science-notebook-mcp'],
      env: [
        { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
        { name: 'OPEN_SCIENCE_NOTEBOOK_RPC_ENDPOINT', value: 'http://127.0.0.1:4567' },
        { name: 'OPEN_SCIENCE_NOTEBOOK_RPC_TOKEN', value: 'secret-token' },
        { name: 'OPEN_SCIENCE_NOTEBOOK_PROJECT_ID', value: 'default-project' },
        { name: 'OPEN_SCIENCE_NOTEBOOK_SESSION_ID', value: 'session-1' },
        { name: 'OPEN_SCIENCE_NOTEBOOK_WORKSPACE_CWD', value: '/workspace' },
        { name: 'OPEN_SCIENCE_NOTEBOOK_MEMORY_TOOLS', value: '1' }
      ]
    })
  })

  it('accepts legacy projectName but rejects conflicting project environment values', () => {
    const base = {
      OPEN_SCIENCE_NOTEBOOK_RPC_ENDPOINT: 'http://127.0.0.1:4567',
      OPEN_SCIENCE_NOTEBOOK_RPC_TOKEN: 'secret-token',
      OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'session-1',
      OPEN_SCIENCE_NOTEBOOK_WORKSPACE_CWD: '/workspace'
    }
    expect(
      createNotebookMcpEnvironmentFromProcess({
        ...base,
        OPEN_SCIENCE_NOTEBOOK_PROJECT_NAME: 'legacy-project-id'
      }).projectId
    ).toBe('legacy-project-id')
    expect(() =>
      createNotebookMcpEnvironmentFromProcess({
        ...base,
        OPEN_SCIENCE_NOTEBOOK_PROJECT_ID: 'project-1',
        OPEN_SCIENCE_NOTEBOOK_PROJECT_NAME: 'renamed-project'
      })
    ).toThrow('Conflicting projectId and legacy projectName values.')
  })

  it('passes the Windows named-pipe path to the notebook MCP process', () => {
    const config = createNotebookMcpServerConfig({
      command: 'C:\\Open Science.exe',
      entryPath: 'C:\\app\\main.js',
      endpoint: 'http://localhost',
      socketPath: '\\\\.\\pipe\\open-science-notebook',
      token: 'secret-token',
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: 'C:\\workspace',
      memoryTools: false
    })

    expect(config.env).toContainEqual({
      name: 'OPEN_SCIENCE_NOTEBOOK_RPC_SOCKET_PATH',
      value: '\\\\.\\pipe\\open-science-notebook'
    })
    expect(config.env).toContainEqual({
      name: 'OPEN_SCIENCE_NOTEBOOK_MEMORY_TOOLS',
      value: '0'
    })
  })

  it('advertises memory tools only to an eligible main-agent environment', () => {
    const base = {
      endpoint: 'http://127.0.0.1:4567',
      token: 'token',
      projectId: 'project',
      sessionId: 'session',
      workspaceCwd: '/workspace'
    }
    expect(
      notebookRpcToolsForEnvironment({ ...base, memoryTools: true }).map(({ name }) => name)
    ).toEqual(
      expect.arrayContaining(['list_memory_categories', 'search_memories', 'remember_memory'])
    )
    expect(
      notebookRpcToolsForEnvironment({ ...base, memoryTools: false }).map(({ name }) => name)
    ).not.toEqual(
      expect.arrayContaining(['list_memory_categories', 'search_memories', 'remember_memory'])
    )
  })

  it('keeps notebook instructions scoped to the notebook tools', () => {
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain(
      'only applies when using open-science-notebook tools'
    )
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('OPEN_SCIENCE_RUNTIME_DIR')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).not.toContain('~/.open-science/runtime/')
    // The prompt guides relative writes to the working directory rather than a guessed absolute path.
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('writable session workspace')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('plain relative paths')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).not.toContain(
      '~/.open-science/notebooks/default-project/<sessionId>/'
    )
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('workingFiles')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain(
      'The notebook runtime does not classify files for you'
    )
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('not an execution verdict')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain(
      '`stale` means a tracked dependency changed after that run'
    )
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain(
      'does not mean the run failed or its captured output is incorrect'
    )
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('write_artifact_file')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('open-science-artifacts')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).not.toContain(
      '`open-science-artifacts.write_artifact_file`'
    )
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('"kind": "localPath"')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).not.toContain(
      'for binary final outputs, read base64 content'
    )
    // write_artifact_file now resolves a relative name against the notebook data dir, so the guidance
    // must steer the model to the saved relative filename — not to a rebuilt absolute path. Guard the
    // old "use an ABSOLUTE path" / "will not resolve a bare relative name" wording from regressing.
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('the SAME relative filename you saved with')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain(
      'producerRunId` set to the exact `runId` returned by the execution'
    )
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).not.toContain('use an ABSOLUTE path')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).not.toContain('will not resolve a bare relative name')
  })

  it('bounds recovery after repeated kernel-process failures', () => {
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toMatch(/repeated kernel-process failures/i)
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toMatch(/retry once at most/i)
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toMatch(/stop Notebook tools/i)
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toMatch(/report the failure/i)
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).not.toContain('then revise/rerun')
  })

  it('directs agents to concise Host SDK help without prefetching every topic', () => {
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('Main/root agents')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain("await host.help('delegate')")
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('role-aware catalog')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('field descriptions')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toMatch(/do not prefetch.*topics/i)
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('Delegate agents should use the same catalog')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('unavailable root-only topics remain visible')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).not.toContain('host.sendFrameMessage(')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).not.toContain('host.send_message(')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).not.toContain('{task')

    expect(REPL_EXECUTE_DOC).toContain("await host.help('delegate')")
    expect(REPL_EXECUTE_DOC).toMatch(/do not prefetch.*topics/i)
  })

  it('does not inject a 4000-character output instruction into agent guidance', () => {
    const agentGuidance = [
      NOTEBOOK_SYSTEM_PROMPT_APPEND,
      ...NOTEBOOK_RPC_TOOLS.map((tool) => tool.description)
    ].join('\n')

    expect(agentGuidance).not.toMatch(/\b4,?000\b/)
    expect(REPL_EXECUTE_DOC).toContain('hand off large data from the REPL to Python/R')
    expect(REPL_EXECUTE_DOC).toContain('Python/R reads the same OPEN_SCIENCE_HANDOFF_DIR path')
    expect(REPL_EXECUTE_DOC).not.toContain('Do not echo large data')
  })

  it('directs the agent to run code as one notebook_execute call per cell', () => {
    // The single-step execute tool keeps each cell to one permission prompt and one activity row,
    // instead of the old begin/append/finish/run streaming sequence.
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('notebook_execute')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).not.toContain('append code deltas')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).not.toContain('finish the cell')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('repeat kernelSkillIds per dependent cell')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('call directly in code')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('never import')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).not.toMatch(/host registry|injected exports|live kernel/i)
    const executeTool = NOTEBOOK_RPC_TOOLS.find((entry) => entry.name === 'notebook_execute')
    expect(executeTool?.description).toContain('producerRunId')
  })

  it('exposes only the single-step execute tool for writing and running code', () => {
    const toolNames = NOTEBOOK_RPC_TOOLS.map((tool) => tool.name)

    expect(toolNames).toContain('notebook_execute')
    expect(toolNames).not.toContain('notebook_begin_code_cell')
    expect(toolNames).not.toContain('notebook_append_code_cell')
    expect(toolNames).not.toContain('notebook_finish_code_cell')
    expect(toolNames).not.toContain('notebook_run_cell')
  })

  it('locks the complete Notebook MCP capability inventory', () => {
    expect(NOTEBOOK_RPC_TOOLS.map((tool) => tool.name)).toEqual([
      'ask_user_question',
      'notebook_execute',
      'repl_execute',
      'bash_execute',
      'request_network_access',
      'notebook_state',
      'list_notebook_runtimes',
      'notebook_bind_runtime',
      'notebook_switch_runtime',
      'notebook_restart',
      'notebook_shutdown',
      'inspect_packages',
      'manage_packages',
      'manage_environments',
      'list_memory_categories',
      'search_memories',
      'remember_memory'
    ])
  })

  it('ties network access requests to a real sandbox denial and an approved retry', () => {
    const tool = NOTEBOOK_RPC_TOOLS.find((candidate) => candidate.name === 'request_network_access')

    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('OPEN_SCIENCE_NETWORK_DOMAIN_BLOCKED')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('call `request_network_access`')
    expect(tool?.description).toContain(
      'Call only after Notebook execution reports OPEN_SCIENCE_NETWORK_DOMAIN_BLOCKED'
    )
    expect(tool?.description).toContain(
      'Retry the failed execution only when the result is allowed'
    )
  })

  it('exposes bounded memory discovery, search, and append-only agent tools', () => {
    const tools = Object.fromEntries(NOTEBOOK_RPC_TOOLS.map((tool) => [tool.name, tool]))

    expect(tools.list_memory_categories?.method).toBe('memoryListCategories')
    expect(tools.search_memories?.method).toBe('memorySearch')
    expect(tools.remember_memory?.method).toBe('memoryRemember')
    expect(tools.remember_memory?.description).toContain('durable')
    expect(tools.remember_memory?.description).toContain('current project')
    expect(tools.remember_memory?.description).toContain('Do not retry')
    expect(tools.remember_memory?.description).toContain('hidden agent-specific memory directories')
    expect(tools.search_memories?.inputSchema).toBe(memoryAgentSearchRequestSchema.shape)
    expect(tools.remember_memory?.inputSchema).toBe(memoryAgentRememberRequestSchema.shape)
    expect(tools.remember_memory?.outputSchema).toBe(memoryAgentRememberMcpOutputSchema)
    expect(tools.list_memory_categories?.mapResult).toBeUndefined()
    expect(tools.search_memories?.mapResult).toBeUndefined()
    expect(tools.remember_memory?.mapResult).toBeUndefined()
    expect(NOTEBOOK_RPC_TOOLS.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(['update_memory', 'forget_memory', 'set_memory_enabled'])
    )
  })

  it('publishes remember_memory with a root object output schema', async () => {
    const environment = {
      endpoint: 'http://127.0.0.1:4567',
      token: 'secret-token',
      projectId: 'project-1',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      memoryTools: true
    }
    const server = createNotebookMcpServer(environment)
    const client = new ModelContextProtocolClient({ name: 'notebook-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    try {
      const { tools } = await client.listTools()
      const rememberTool = tools.find(({ name }) => name === 'remember_memory')

      expect(rememberTool?.outputSchema).toEqual(expect.objectContaining({ type: 'object' }))
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('returns a created memory through the real MCP client and calls RPC once', async () => {
    const { result, rpcCallCount } = await callRememberMemoryThroughMcp({
      status: 'created',
      memory: {
        id: 'entry-1',
        categoryId: null,
        categoryName: null,
        scope: 'project',
        content: 'Use channel A for this project.',
        revision: 1,
        provenance: { origin: 'agent', agentId: 'agent-1' },
        updatedAt: 3
      }
    })

    expect(result.content).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('_zod') })])
    )
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({
      status: 'created',
      memory: {
        id: 'entry-1',
        categoryId: null,
        categoryName: null,
        scope: 'project',
        content: 'Use channel A for this project.',
        revision: 1,
        provenance: { origin: 'agent', agentId: 'agent-1' },
        updatedAt: 3
      }
    })
    expect(rpcCallCount).toBe(1)
  })

  it('returns an existing memory through the real MCP client', async () => {
    const { result, rpcCallCount } = await callRememberMemoryThroughMcp({
      status: 'existing',
      memory: {
        id: 'entry-1',
        categoryId: null,
        categoryName: null,
        scope: 'project',
        content: 'Use channel A for this project.',
        revision: 1,
        provenance: { origin: 'agent', agentId: 'agent-1' },
        updatedAt: 3
      }
    })

    expect(result.content).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('_zod') })])
    )
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({
      status: 'existing',
      memory: {
        id: 'entry-1',
        categoryId: null,
        categoryName: null,
        scope: 'project',
        content: 'Use channel A for this project.',
        revision: 1,
        provenance: { origin: 'agent', agentId: 'agent-1' },
        updatedAt: 3
      }
    })
    expect(rpcCallCount).toBe(1)
  })

  it('returns rejected memory writes as structured non-retryable MCP errors', async () => {
    const environment = {
      endpoint: 'http://127.0.0.1:4567',
      token: 'secret-token',
      projectId: 'project-1',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      memoryTools: true
    }
    const server = createNotebookMcpServer(environment)
    const client = new ModelContextProtocolClient({ name: 'notebook-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({
            result: {
              status: 'rejected',
              retryable: false,
              code: 'invalid_analysis',
              reason: 'The note does not describe durable project knowledge.'
            }
          })
        }) as Response
    ) as typeof fetch

    try {
      const result = await client.callTool({
        name: 'remember_memory',
        arguments: {
          content: 'Temporary output',
          analysis: {
            scope: 'project',
            durability: 'cross-session',
            evidence: 'project-observed',
            subject: 'Temporary output',
            reason: 'This should be rejected by the service.'
          }
        }
      })

      expect(result.isError).toBe(true)
      expect(result.structuredContent).toEqual({
        status: 'rejected',
        retryable: false,
        code: 'invalid_analysis',
        reason: 'The note does not describe durable project knowledge.'
      })
      expect(result.content).toEqual([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('The note does not describe durable project knowledge.')
        })
      ])
    } finally {
      globalThis.fetch = originalFetch
      await client.close()
      await server.close()
    }
  })

  it('exposes manage_environments and explains named environments are separate namespaces', () => {
    const toolNames = NOTEBOOK_RPC_TOOLS.map((tool) => tool.name)
    expect(toolNames).toContain('manage_environments')

    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('manage_environments')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('process.env.OPEN_SCIENCE_HANDOFF_DIR')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).not.toContain('./handoff/')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND.toLowerCase()).toContain('separate')
  })
})

describe('ask_user_question tool', () => {
  const tool = NOTEBOOK_RPC_TOOLS.find((entry) => entry.name === 'ask_user_question')

  it('accepts 1-3 compact questions', () => {
    expect(tool).toBeDefined()
    expect(tool?.method).toBe('requestUserInput')
    expect(tool?.description).toContain('app-owned tool')
    expect(tool?.description).toContain('materially different interpretations')
    expect(tool?.description).toContain('first tool call')
    expect(tool?.description).toContain('include every known question in one call')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('ask_user_question')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('materially different interpretations')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('first tool call')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('all 1-3 known questions in one call')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('do not inspect or use other tools first')

    const schema = z.object(tool?.inputSchema ?? {})
    const option = (label: string): { label: string; description: string } => ({
      label,
      description: `${label} details`
    })

    expect(
      schema.parse({
        questions: [
          {
            question: 'Which path should I take?',
            header: 'Approach',
            options: [option('Minimal'), option('Expanded')]
          },
          {
            question: 'Which output should I produce?',
            header: 'Output',
            options: [option('Notebook'), option('Report')]
          }
        ]
      })
    ).toEqual({
      questions: [
        {
          question: 'Which path should I take?',
          header: 'Approach',
          options: [option('Minimal'), option('Expanded')]
        },
        {
          question: 'Which output should I produce?',
          header: 'Output',
          options: [option('Notebook'), option('Report')]
        }
      ]
    })
    expect(() =>
      schema.parse({
        questions: [
          {
            question: 'Which path?',
            options: [option('A'), option('B'), option('C'), option('D'), option('E')]
          }
        ]
      })
    ).toThrow()
    expect(() =>
      schema.parse({
        questions: [
          { question: 'One?', options: [option('A'), option('B')] },
          { question: 'Two?', options: [option('A'), option('B')] },
          { question: 'Three?', options: [option('A'), option('B')] },
          { question: 'Four?', options: [option('A'), option('B')] }
        ]
      })
    ).toThrow()
  })

  it('returns only the choice outcome within the shared control-tool result budget', () => {
    expect(
      tool?.mapResult?.(
        { action: 'answered', answer: 'Minimal', internal: 'must not reach the agent' },
        {}
      )
    ).toEqual({ action: 'answered', answer: 'Minimal' })
    expect(tool?.resultLimitChars).toBe(NOTEBOOK_MCP_CONTROL_RESULT_LIMIT)
  })
})

describe('notebook_execute tool', () => {
  const tool = NOTEBOOK_RPC_TOOLS.find((entry) => entry.name === 'notebook_execute')

  it('accepts an optional language enum defaulting to python when omitted', () => {
    expect(tool).toBeDefined()
    const schema = z.object(tool?.inputSchema ?? {})

    // Omitted language must still validate — python is the implicit default.
    expect(schema.parse({ code: 'print(1)' })).toEqual({ code: 'print(1)' })
    expect(schema.parse({ code: '1 + 1', language: 'r' })).toEqual({
      code: '1 + 1',
      language: 'r'
    })
    expect(() => schema.parse({ code: 'x', language: 'julia' })).toThrow()
  })

  it('accepts only stable kernel Skill IDs and never implementation descriptors', () => {
    const schema = z.object(tool?.inputSchema ?? {})

    expect(
      schema.parse({ code: 'public_add(2)', kernelSkillIds: ['registered-test-helper'] })
    ).toEqual({ code: 'public_add(2)', kernelSkillIds: ['registered-test-helper'] })
    expect(() =>
      schema.parse({
        code: 'public_add(2)',
        kernelSkillIds: [
          { id: 'registered-test-helper', path: '/tmp/kernel.py', source: 'x', digest: 'x' }
        ]
      })
    ).toThrow()
    expect(schema.parse({ code: 'public_add(2)', helperModules: ['legacy-name'] })).toEqual({
      code: 'public_add(2)'
    })
    expect(tool?.inputSchema.kernelSkillIds?.description).toContain('called functions')
    expect(tool?.inputSchema.kernelSkillIds?.description).toContain('per dependent cell')
    expect(tool?.inputSchema.kernelSkillIds?.description).toContain('call directly, never import')
  })

  it('accepts bounded Artifact Version identities as explicit Run inputs', () => {
    const schema = z.object(tool?.inputSchema ?? {})

    expect(
      schema.parse({
        code: 'compose_figure(...)',
        artifactVersionInputs: ['panel-a-v1', 'panel-b-v1']
      })
    ).toEqual({
      code: 'compose_figure(...)',
      artifactVersionInputs: ['panel-a-v1', 'panel-b-v1']
    })
    expect(() =>
      schema.parse({ code: 'x', artifactVersionInputs: [{ versionId: 'panel-a-v1' }] })
    ).toThrow()
    expect(tool?.description).toContain("this Run's provenance inputs")
  })

  it('has no per-call environment param — the env is the session-bound runtime (v4)', () => {
    expect(tool).toBeDefined()
    // The env is the session's bound runtime (notebook_bind_runtime), not a per-call argument, so the
    // schema has no `environment` key and strips it if passed.
    expect(Object.keys(tool?.inputSchema ?? {})).not.toContain('environment')
    const schema = z.object(tool?.inputSchema ?? {})
    expect(schema.parse({ code: 'print(1)', environment: 'my-analysis' })).toEqual({
      code: 'print(1)'
    })
  })

  it('does not expose a hidden execution deadline to the agent', () => {
    expect(tool).toBeDefined()
    expect(Object.keys(tool?.inputSchema ?? {})).not.toContain('timeoutMs')

    const schema = z.object(tool?.inputSchema ?? {})
    expect(schema.parse({ code: 'print(1)', timeoutMs: 5 })).toEqual({ code: 'print(1)' })
  })

  it('forwards language, helper IDs, and Artifact Version inputs to the execute RPC call', async () => {
    const environment = {
      endpoint: 'http://127.0.0.1:4567',
      token: 'secret-token',
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace'
    }
    // The MCP tool handler passes schema-validated input straight to callNotebookRpc as the
    // RPC params, so asserting the call helper forwards `language` covers the handler wiring.
    const fetchCalls: Array<{ body: string }> = []
    const fetchRpc = async (_environment: unknown, init: RequestInit): Promise<Response> => {
      fetchCalls.push({ body: String(init?.body ?? '') })
      return {
        ok: true,
        json: async () => ({ result: { ok: true } })
      } as Response
    }

    const result = await callNotebookRpc(
      environment,
      'execute',
      {
        code: '1 + 1',
        language: 'r',
        kernelSkillIds: ['registered-test-helper'],
        artifactVersionInputs: ['panel-a-v1', 'panel-b-v1'],
        projectId: 'forged-project',
        sessionId: 'forged-session'
      },
      fetchRpc
    )

    expect(result).toEqual({ ok: true })
    expect(fetchCalls).toHaveLength(1)
    const sentBody = JSON.parse(fetchCalls[0].body) as {
      params: {
        language?: string
        kernelSkillIds?: string[]
        artifactVersionInputs?: string[]
        projectId?: string
        sessionId?: string
      }
    }
    expect(sentBody.params.language).toBe('r')
    expect(sentBody.params.kernelSkillIds).toEqual(['registered-test-helper'])
    expect(sentBody.params.artifactVersionInputs).toEqual(['panel-a-v1', 'panel-b-v1'])
    expect(sentBody.params.projectId).toBe('default-project')
    expect(sentBody.params.sessionId).toBe('session-1')
  })

  it.each([
    ['execute', true],
    ['executeControl', false],
    ['executeShell', false],
    ['state', true]
  ] as const)(
    'forwards MCP cancellation for %s only when the RPC consumes it',
    async (method, forwards) => {
      const environment = {
        endpoint: 'http://127.0.0.1:4567',
        token: 'secret-token',
        projectId: 'default-project',
        sessionId: 'session-1',
        workspaceCwd: '/workspace'
      }
      const cancellation = new AbortController()
      let forwardedSignal: AbortSignal | null | undefined
      const fetchRpc = async (_environment: unknown, init: RequestInit): Promise<Response> => {
        forwardedSignal = init.signal
        return {
          ok: true,
          json: async () => ({ result: { ok: true } })
        } as Response
      }

      await callNotebookRpc(environment, method, { code: '1 + 1' }, fetchRpc, cancellation.signal)

      expect(forwardedSignal).toBe(forwards ? cancellation.signal : undefined)
    }
  )

  it('uses the unbounded transport for long-running kernel execution', () => {
    expect(resolveNotebookRpcFetch('execute').name).toBe('fetchLongLivedLocalRpc')
    expect(resolveNotebookRpcFetch('executeControl').name).toBe('fetchLongLivedLocalRpc')
    expect(resolveNotebookRpcFetch('state').name).toBe('fetchLocalRpc')
  })

  it.each([
    ['notebook_execute', 'Notebook execution is still running.'],
    ['repl_execute', 'Control-plane REPL execution is still running.']
  ])('keeps a long-running %s call alive with MCP progress', async (toolName, progressMessage) => {
    const environment = {
      endpoint: 'http://127.0.0.1:4567',
      token: 'secret-token',
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace'
    }
    const server = createNotebookMcpServer(environment)
    const client = new ModelContextProtocolClient({ name: 'notebook-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const originalFetch = globalThis.fetch
    let finishRpc: ((response: Response) => void) | undefined
    globalThis.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finishRpc = resolve
        })
    ) as typeof fetch
    vi.useFakeTimers()
    const progress: Array<{ progress: number; message?: string }> = []
    let call: ReturnType<typeof client.callTool> | undefined

    try {
      call = client.callTool(
        { name: toolName, arguments: { code: 'long_running_analysis()' } },
        undefined,
        {
          onprogress: (update) => progress.push(update),
          timeout: 90_000,
          resetTimeoutOnProgress: true
        }
      )
      await vi.advanceTimersByTimeAsync(30_000)

      expect(progress).toEqual([
        expect.objectContaining({
          progress: 1,
          message: progressMessage
        })
      ])

      finishRpc?.({
        ok: true,
        json: async () => ({ result: { status: 'completed' } })
      } as Response)
      finishRpc = undefined
      await call
      await vi.advanceTimersByTimeAsync(30_000)
      expect(progress).toHaveLength(1)
    } finally {
      finishRpc?.({
        ok: true,
        json: async () => ({ result: { status: 'completed' } })
      } as Response)
      await call?.catch(() => undefined)
      vi.useRealTimers()
      globalThis.fetch = originalFetch
      await client.close()
      await server.close()
    }
  })
})

describe('repl_execute tool', () => {
  const tool = NOTEBOOK_RPC_TOOLS.find((entry) => entry.name === 'repl_execute')

  it('registers repl_execute backed by the executeControl RPC method with a code/timeoutMs schema', () => {
    expect(tool).toBeDefined()
    expect(tool?.method).toBe('executeControl')

    const schema = z.object(tool?.inputSchema ?? {})
    expect(schema.parse({ code: 'return 1' })).toEqual({
      code: 'return 1',
      timeoutMs: 1_815_000
    })
    expect(schema.parse({ code: 'return 1', timeoutMs: 5000 })).toEqual({
      code: 'return 1',
      timeoutMs: 5000
    })
    expect(() => schema.parse({})).toThrow()
    // The control-plane repl takes no language/cellId — it is distinct from notebook_execute.
    expect(Object.keys(tool?.inputSchema ?? {})).toEqual(['code', 'timeoutMs'])
  })

  it('returns compact text followed by ordered transient MCP image blocks without embedding Base64', () => {
    const first = Buffer.from('first-image').toString('base64')
    const second = Buffer.from('second-image').toString('base64')
    const content = buildNotebookToolContent(
      {
        status: 'completed',
        stdout: 'done',
        viewImages: [
          { data: first, mimeType: 'image/png' },
          { data: second, mimeType: 'image/jpeg' }
        ]
      },
      { includeViewImages: true, mapResult: compactNotebookExecutionResult }
    )

    expect(content).toEqual([
      { type: 'text', text: expect.stringContaining('"status": "completed"') },
      { type: 'image', data: first, mimeType: 'image/png' },
      { type: 'image', data: second, mimeType: 'image/jpeg' }
    ])
    expect((content[0] as { text: string }).text).not.toContain(first)
    expect(
      buildNotebookToolContent(
        { status: 'completed', viewImages: [{ data: first, mimeType: 'image/png' }] },
        { includeViewImages: false, mapResult: compactNotebookExecutionResult }
      )
    ).toEqual([{ type: 'text', text: expect.any(String) }])
  })

  it('fails the entire transient image attachment when any image block is malformed', () => {
    const valid = Buffer.from('valid-image').toString('base64')

    expect(() =>
      buildNotebookToolContent(
        {
          status: 'completed',
          viewImages: [
            { data: valid, mimeType: 'image/png' },
            { data: 'not base64!', mimeType: 'image/jpeg' }
          ]
        },
        { includeViewImages: true, mapResult: compactNotebookExecutionResult }
      )
    ).toThrow(/invalid transient image content/u)
  })

  it('describes the control-plane repl (host.mcp + handoff) distinctly from notebook_execute', () => {
    expect(tool?.description).toBe(REPL_EXECUTE_DOC)
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('host.capabilities')
    expect(tool?.description).toContain('host.capabilities')
    expect(tool?.description).toContain('host.llm')
    expect(tool?.description).toContain('self-awareness')
    expect(tool?.description).toContain('host.mcp')
    // host.compute (remote compute) is only reachable here too, same as host.mcp.
    expect(tool?.description).toContain('host.compute')
    expect(tool?.description).toContain('host.agents')
    expect(tool?.description).toContain('host.help()')
    expect(tool?.description).not.toContain('host.skills')
    expect(tool?.description).toContain('process.env.OPEN_SCIENCE_HANDOFF_DIR')
    expect(tool?.description).not.toContain('./handoff/')
    expect(tool?.description.toLowerCase()).toContain('connector')
    expect(tool?.description).toContain('notebook_execute')
  })

  it('directs Node module loading through the CommonJS REPL contract', () => {
    expect(tool?.description).toContain(
      "This is a CommonJS REPL: load Node modules with `require('node:fs')`, not dynamic `import()`."
    )
  })

  it('advertises the role-scoped subagent Host SDK on the only tool that can call it', () => {
    expect(tool?.description).toContain('Main/root agents')
    expect(tool?.description).toContain('host.help')
    expect(tool?.description).toContain("host.help('delegate')")
    expect(tool?.description).toContain('role-aware catalog')
    expect(tool?.description).toContain('field descriptions')
    expect(tool?.description).toMatch(/do not prefetch.*topics/i)
    expect(tool?.description).toContain('Delegate agents should use the same catalog')
    expect(tool?.description).not.toContain('host.sendFrameMessage(')
    expect(tool?.description).not.toContain('host.send_message(')
  })

  it('keeps the concise delegate guide intact through the Agent-facing execution projection', () => {
    const capabilities = Object.fromEntries(
      HOST_SDK_SUBAGENT_OPERATION_IDS.map((id) => [id.slice('host.'.length), true])
    ) as Record<
      (typeof HOST_SDK_SUBAGENT_OPERATION_IDS)[number] extends `host.${infer Op}` ? Op : never,
      boolean
    >
    const guide = JSON.stringify(
      hostSdkHelp.query('delegate', { callerRole: 'main', capabilities })
    )

    const compact = compactNotebookExecutionResult({
      status: 'completed',
      outputs: [{ type: 'display', data: { 'text/plain': guide } }]
    }) as { truncated?: boolean; outputs?: Array<{ data: Record<string, string> }> }

    expect(compact.truncated).toBeUndefined()
    expect(compact.outputs?.[0].data['text/plain']).toBe(guide)
    expect(guide).not.toContain('omitted')
  })

  it('forwards repl_execute input to the executeControl RPC method', async () => {
    const environment = {
      endpoint: 'http://127.0.0.1:4567',
      token: 'secret-token',
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace'
    }
    const fetchCalls: Array<{ body: string }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      fetchCalls.push({ body: String(init?.body ?? '') })
      return {
        ok: true,
        json: async () => ({ result: { status: 'completed' } })
      } as Response
    }) as typeof fetch

    try {
      await callNotebookRpc(environment, tool?.method ?? '', { code: 'return 2' })

      expect(fetchCalls).toHaveLength(1)
      const body = JSON.parse(fetchCalls[0].body) as {
        method: string
        params: { code?: string }
      }
      expect(body.method).toBe('executeControl')
      expect(body.params.code).toBe('return 2')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('bash_execute tool', () => {
  const tool = NOTEBOOK_RPC_TOOLS.find((entry) => entry.name === 'bash_execute')

  it('registers bash_execute backed by the executeShell RPC method with a command/timeoutMs schema', () => {
    expect(tool).toBeDefined()
    expect(tool?.method).toBe('executeShell')

    const schema = z.object(tool?.inputSchema ?? {})
    expect(schema.parse({ command: 'echo hi' })).toEqual({ command: 'echo hi' })
    expect(schema.parse({ command: 'echo hi', timeoutMs: 5000 })).toEqual({
      command: 'echo hi',
      timeoutMs: 5000
    })
    expect(() => schema.parse({})).toThrow()
    expect(Object.keys(tool?.inputSchema ?? {})).toEqual(['command', 'timeoutMs'])
  })

  it('describes the stateless per-call shell distinctly from the persistent kernels', () => {
    expect(tool?.description).toBe(BASH_EXECUTE_DOC)
    expect(tool?.description.toLowerCase()).toContain('stateless')
    expect(tool?.description).toContain('fresh process')
    expect(tool?.description.toLowerCase()).toContain('persist')
  })

  it('documents the actual Windows PowerShell dialect and keeps generated notebook files out of shell copies', () => {
    const windowsDoc = buildShellExecuteDoc('win32')

    expect(windowsDoc).toContain('Windows PowerShell')
    expect(windowsDoc).not.toContain('`sh -c`')
    expect(windowsDoc).toContain('$env:OPEN_SCIENCE_HANDOFF_DIR')
    expect(windowsDoc).not.toContain('./handoff/')
    expect(windowsDoc).toContain('Windows PowerShell 5.1')
    expect(windowsDoc).toContain('`&&` is unavailable')
    expect(windowsDoc).toContain('cmdlet failure')
    expect(windowsDoc).toContain('unhandled cmdlet failure')
    expect(windowsDoc).toContain('native programs must emit UTF-8')
    expect(windowsDoc).toContain('write_artifact_file')
    expect(windowsDoc).toContain('Do NOT copy a generated notebook output into the workspace')
    // Aligned with the relative-path artifact flow: point at the saved relative filename, not the
    // old "generated file's absolute local path" wording.
    expect(windowsDoc).toContain('same relative filename you saved with')
    expect(windowsDoc).not.toContain("generated file's absolute local path")
  })

  it('forwards bash_execute input to the executeShell RPC method', async () => {
    const environment = {
      endpoint: 'http://127.0.0.1:4567',
      token: 'secret-token',
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace'
    }
    const fetchCalls: Array<{ body: string }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      fetchCalls.push({ body: String(init?.body ?? '') })
      return {
        ok: true,
        json: async () => ({ result: { stdout: 'hi\n', stderr: '', exitCode: 0 } })
      } as Response
    }) as typeof fetch

    try {
      await callNotebookRpc(environment, tool?.method ?? '', { command: 'echo hi' })

      expect(fetchCalls).toHaveLength(1)
      const body = JSON.parse(fetchCalls[0].body) as {
        method: string
        params: { command?: string }
      }
      expect(body.method).toBe('executeShell')
      expect(body.params.command).toBe('echo hi')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('manage_packages tool', () => {
  const tool = NOTEBOOK_RPC_TOOLS.find((entry) => entry.name === 'manage_packages')

  it('registers manage_packages backed by the managePackages RPC method', () => {
    expect(tool).toBeDefined()
    expect(tool?.method).toBe('managePackages')
    expect(tool?.mapResult).toBe(compactManagePackagesResult)
    expect(Object.keys(tool?.inputSchema ?? {})).toEqual(
      expect.arrayContaining(['language', 'packages', 'usePip', 'installer', 'channels'])
    )
    expect(tool?.description).toContain('target receipt')
    expect(tool?.description).toContain('distribution metadata')
    expect(tool?.description).toContain('notebook_execute')
  })

  it('accepts explicit Bioconductor and GitHub installers for R requests', () => {
    const schema = z.object(tool?.inputSchema ?? {})

    expect(schema.parse({ language: 'r', packages: ['DESeq2'], installer: 'biocmanager' })).toEqual(
      { language: 'r', packages: ['DESeq2'], installer: 'biocmanager' }
    )
    expect(
      schema.parse({ language: 'r', packages: ['tidyverse/ggplot2@main'], installer: 'github' })
    ).toEqual({
      language: 'r',
      packages: ['tidyverse/ggplot2@main'],
      installer: 'github'
    })
  })

  it('preserves bounded installer-log truncation metadata in the compact result', () => {
    expect(
      compactManagePackagesResult({
        ok: true,
        needsRestart: false,
        method: 'pip',
        log: 'latest retained output',
        logTruncation: { droppedBytes: 524_321 }
      })
    ).toEqual({
      ok: true,
      needsRestart: false,
      method: 'pip',
      logTruncation: { droppedBytes: 524_321 }
    })
  })

  it.each([
    ['changed', { ok: true, needsRestart: true }],
    ['unchanged', { ok: true, needsRestart: false }],
    ['failure', { ok: false, needsRestart: false, error: 'installation failed' }]
  ] as const)(
    'keeps the structured target when %s package changes exceed the MCP budget',
    (_outcome, result) => {
      const target = {
        language: 'python',
        selection: 'explicit-binding',
        runtimeSource: 'external',
        runtimeId: '/usr/local/bin/python3',
        label: 'Research Python'
      }
      const packageChanges = [
        ...Array.from({ length: 60 }, (_, index) => ({
          name: `package-${index}-${'x'.repeat(1_000)}`,
          ecosystem: 'python',
          relationship: 'dependency',
          change: result.ok ? _outcome : 'unknown',
          beforeVersion: `1.${index}.${'y'.repeat(1_000)}`,
          afterVersion: `2.${index}.${'z'.repeat(1_000)}`
        })),
        {
          name: 'requested-package',
          ecosystem: 'python',
          relationship: 'requested',
          change: result.ok ? _outcome : 'unknown',
          afterVersion: '2.0.0'
        }
      ]

      const content = buildNotebookToolContent({ ...result, target, packageChanges }, tool!)
      const text = (content[0] as { type: 'text'; text: string }).text
      const parsed = JSON.parse(text) as {
        target?: unknown
        packageChanges?: unknown[]
        omittedPackageChangeCount?: number
        preview?: string
      }

      expect(text.length).toBeLessThanOrEqual(NOTEBOOK_MCP_CONTROL_RESULT_LIMIT)
      expect(parsed.target).toEqual(target)
      expect(parsed.preview).toBeUndefined()
      expect(parsed.packageChanges?.length).toBeLessThan(packageChanges.length)
      expect(parsed.packageChanges).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'requested-package' })])
      )
      expect(parsed.omittedPackageChangeCount).toBeGreaterThan(0)
    }
  )

  it('has no per-call environment param — installs target the session-bound runtime (v4)', () => {
    // The env is the session's bound runtime, not a per-call argument, so the schema has no
    // `environment` key and strips it if passed.
    expect(Object.keys(tool?.inputSchema ?? {})).not.toContain('environment')
    const schema = z.object(tool?.inputSchema ?? {})
    expect(
      schema.parse({ language: 'python', packages: ['numpy'], environment: 'my-analysis' })
    ).toEqual({ language: 'python', packages: ['numpy'] })
  })

  it('accepts an optional operation enum (install/uninstall) defaulting to install when omitted', () => {
    const schema = z.object(tool?.inputSchema ?? {})

    expect(
      schema.parse({ language: 'python', packages: ['numpy'], operation: 'uninstall' })
    ).toEqual({ language: 'python', packages: ['numpy'], operation: 'uninstall' })
    // Omitted operation still validates — install is the implicit default.
    expect(schema.parse({ language: 'python', packages: ['numpy'] })).toEqual({
      language: 'python',
      packages: ['numpy']
    })
    expect(() =>
      schema.parse({ language: 'python', packages: ['numpy'], operation: 'purge' })
    ).toThrow()
  })

  it('documents the uninstall operation on the same env', () => {
    expect(MANAGE_PACKAGES_DOC).toContain('operation:"uninstall"')
  })

  it('embeds the install contract forbidding kernel-side and OS installers', () => {
    const doc = MANAGE_PACKAGES_DOC
    for (const phrase of [
      '%pip',
      '!pip',
      'install.packages(',
      'sudo',
      'apt',
      'brew',
      'curl | bash',
      'subprocess'
    ]) {
      expect(doc).toContain(phrase)
    }
    // Routing, restart, and the stop-and-report boundary are all stated.
    expect(doc).toContain('language="python"')
    expect(doc).toContain('language="r"')
    expect(doc).toContain('notebook_restart')
    expect(doc).toMatch(/report .*user|tell the user/i)
  })

  it('uses the contract doc as the tool description so the agent sees it', () => {
    expect(tool?.description).toBe(MANAGE_PACKAGES_DOC)
  })

  it('points the notebook system prompt at manage_packages as the only install path', () => {
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('manage_packages')
  })
})

describe('inspect_packages tool', () => {
  const tool = NOTEBOOK_RPC_TOOLS.find((entry) => entry.name === 'inspect_packages')

  it('registers a targeted read-only package query for the session-bound runtime', () => {
    expect(tool).toBeDefined()
    expect(tool?.method).toBe('inspectPackages')
    expect(tool?.description).toBe(INSPECT_PACKAGES_DOC)
    expect(tool?.description).toMatch(/external runtime.*notebook_execute/)
    expect(Object.keys(tool?.inputSchema ?? {})).toEqual(['language', 'packages'])

    const schema = z.object(tool?.inputSchema ?? {})
    expect(schema.parse({ language: 'python', packages: ['numpy'] })).toEqual({
      language: 'python',
      packages: ['numpy']
    })
    expect(() => schema.parse({ language: 'python', packages: [] })).toThrow()
    expect(schema.parse({ language: 'r', packages: ['dplyr'], environment: 'other' })).toEqual({
      language: 'r',
      packages: ['dplyr']
    })
  })

  it('returns only actionable package status fields with a bounded item count', () => {
    const packages = Array.from({ length: 80 }, (_, index) => ({
      requested: `pkg-${index}`,
      name: `pkg-${index}`,
      status: 'installed',
      version: '1.0.0',
      versionStatus: 'known',
      ecosystem: 'python',
      evidenceSources: ['python-importlib-metadata'],
      libraryRank: index
    }))

    const compact = compactInspectPackagesResult({
      language: 'python',
      environmentName: 'default-python',
      runtimeSource: 'managed',
      runtimeId: '/private/runtime/python',
      runtimeLabel: 'Managed Python',
      inventory: { capturedAt: 'now', source: 'full-scan', validation: 'full-scan' },
      packages,
      warnings: ['x'.repeat(10_000)]
    }) as Record<string, unknown>

    expect(compact).not.toHaveProperty('runtimeId')
    expect(compact.packages as unknown[]).toHaveLength(50)
    expect(compact).toHaveProperty('omittedPackageCount', 30)
    expect(JSON.stringify(compact)).not.toContain('evidenceSources')
    expect(JSON.stringify(compact)).not.toContain('libraryRank')
    expect(JSON.stringify(compact)).not.toContain('full output in notebook preview')
    expect(JSON.stringify(compact)).toContain('omitted from this tool response')
    expect(JSON.stringify(compact).length).toBeLessThanOrEqual(NOTEBOOK_MCP_CONTROL_RESULT_LIMIT)
  })
})

describe('compactManagePackagesResult', () => {
  it('preserves an external target alongside a changed package outcome', () => {
    expect(
      compactManagePackagesResult({
        ok: true,
        needsRestart: false,
        target: {
          language: 'python',
          selection: 'explicit-binding',
          runtimeSource: 'external',
          runtimeId: '/usr/bin/python3',
          label: 'System Python'
        },
        packageChanges: [
          {
            name: 'numpy',
            ecosystem: 'python',
            relationship: 'requested',
            change: 'installed',
            afterVersion: '2.2.0'
          }
        ],
        log: 'verbose installer output'
      })
    ).toEqual({
      ok: true,
      needsRestart: false,
      target: {
        language: 'python',
        selection: 'explicit-binding',
        runtimeSource: 'external',
        runtimeId: '/usr/bin/python3',
        label: 'System Python'
      },
      packageChanges: [
        {
          name: 'numpy',
          ecosystem: 'python',
          relationship: 'requested',
          change: 'installed',
          afterVersion: '2.2.0'
        }
      ]
    })
  })

  it('keeps the package outcome while omitting verbose installer diagnostics', () => {
    const compact = compactManagePackagesResult({
      ok: true,
      needsRestart: true,
      method: 'conda',
      environmentName: 'default-r',
      prefix: '/runtime/envs/default-r',
      fallbackUsed: false,
      target: {
        language: 'r',
        selection: 'explicit-binding',
        runtimeSource: 'managed',
        environmentName: 'r-stats',
        runtimeId: '/runtime/envs/r-stats/bin/R',
        label: 'conda: r-stats',
        prefix: '/runtime/envs/r-stats'
      },
      packageChanges: [
        {
          name: 'dplyr',
          ecosystem: 'r',
          relationship: 'requested',
          change: 'unchanged',
          beforeVersion: '1.1.4',
          afterVersion: '1.1.4'
        },
        {
          name: 'cli',
          ecosystem: 'r',
          relationship: 'unattributed',
          change: 'updated',
          beforeVersion: '3.6.4',
          afterVersion: '3.6.5',
          source: {
            type: 'github',
            repository: 'r-lib/cli',
            ref: 'main',
            commit: 'abc123'
          }
        }
      ],
      log: JSON.stringify({
        actions: {
          FETCH: [{ name: 'r-dplyr', depends: Array.from({ length: 100 }, () => 'dependency') }],
          LINK: [{ name: 'r-dplyr' }]
        }
      }),
      attempts: [
        {
          groupOrdinal: 0,
          installer: 'conda',
          packages: ['r-dplyr'],
          status: 'succeeded',
          mutationRisk: 'confirmed'
        }
      ]
    }) as Record<string, unknown>

    expect(compact).toEqual({
      ok: true,
      needsRestart: true,
      method: 'conda',
      environmentName: 'default-r',
      fallbackUsed: false,
      target: {
        language: 'r',
        selection: 'explicit-binding',
        runtimeSource: 'managed',
        environmentName: 'r-stats',
        runtimeId: '/runtime/envs/r-stats/bin/R',
        label: 'conda: r-stats',
        prefix: '/runtime/envs/r-stats'
      },
      packageChanges: [
        {
          name: 'dplyr',
          ecosystem: 'r',
          relationship: 'requested',
          change: 'unchanged',
          beforeVersion: '1.1.4',
          afterVersion: '1.1.4'
        },
        {
          name: 'cli',
          ecosystem: 'r',
          relationship: 'unattributed',
          change: 'updated',
          beforeVersion: '3.6.4',
          afterVersion: '3.6.5',
          source: {
            type: 'github',
            repository: 'r-lib/cli',
            ref: 'main',
            commit: 'abc123'
          }
        }
      ]
    })
    expect(JSON.stringify(compact)).not.toContain('FETCH')
    expect(JSON.stringify(compact)).not.toContain('r-dplyr')
  })

  it('retains a concise failure reason and passes through non-object results', () => {
    expect(
      compactManagePackagesResult({
        ok: false,
        needsRestart: false,
        log: 'very verbose diagnostics',
        target: {
          language: 'python',
          selection: 'implicit-default',
          runtimeSource: 'managed',
          environmentName: 'default-python',
          runtimeId: '/runtime/envs/default-python/bin/python',
          label: 'default-python',
          prefix: '/runtime/envs/default-python'
        },
        error: 'Package installation could not be verified: dplyr.'
      })
    ).toEqual({
      ok: false,
      needsRestart: false,
      target: {
        language: 'python',
        selection: 'implicit-default',
        runtimeSource: 'managed',
        environmentName: 'default-python',
        runtimeId: '/runtime/envs/default-python/bin/python',
        label: 'default-python',
        prefix: '/runtime/envs/default-python'
      },
      error: 'Package installation could not be verified: dplyr.'
    })
    expect(compactManagePackagesResult(null)).toBeNull()
    expect(compactManagePackagesResult('x')).toBe('x')
  })
})

describe('notebook control tool results', () => {
  it('gives every notebook tool a global result budget and projects only results that need it', () => {
    for (const tool of NOTEBOOK_RPC_TOOLS) {
      expect(tool.resultLimitChars, tool.name).toBeGreaterThan(0)
      if (!tool.name.includes('memor')) expect(tool.mapResult, tool.name).toBeTypeOf('function')
    }
  })

  it('pages selectable runtimes without making omitted runtime IDs undiscoverable', () => {
    const compact = compactListRuntimesResult(
      {
        runtimes: Array.from({ length: 45 }, (_, index) => ({
          language: 'python',
          runtimeId: `managed-python-${index}`,
          source: 'managed',
          provenance: 'app-managed',
          interpreterPath: '/private/runtime/bin/python',
          label: `Managed Python ${index}`,
          version: '3.13',
          runnable: true,
          bound: true
        })),
        bindings: {
          python: {
            language: 'python',
            runtimeId: 'managed-python',
            source: 'managed',
            provenance: 'app-managed',
            interpreterPath: '/private/runtime/bin/python',
            label: 'Managed Python'
          }
        }
      },
      { offset: 40, limit: 5 }
    ) as Record<string, unknown>

    expect(compact).toMatchObject({ runtimeCount: 45, offset: 40 })
    expect(compact.runtimes).toHaveLength(5)
    expect(compact).not.toHaveProperty('nextOffset')
    expect(JSON.stringify(compact)).toContain('managed-python-44')
    expect(JSON.stringify(compact)).not.toContain('interpreterPath')
    expect(JSON.stringify(compact)).not.toContain('/private/runtime')
  })

  it('projects bind, shutdown, and environment receipts to their next-step fields', () => {
    expect(
      compactRuntimeBindingResult({
        bound: {
          language: 'r',
          runtimeId: 'managed-r',
          source: 'managed',
          provenance: 'app-managed',
          interpreterPath: '/private/runtime/bin/R',
          label: 'Managed R',
          status: 'active'
        },
        bindings: { r: { interpreterPath: '/private/runtime/bin/R' } }
      })
    ).toEqual({
      bound: {
        language: 'r',
        runtimeId: 'managed-r',
        source: 'managed',
        provenance: 'app-managed',
        label: 'Managed R',
        status: 'active'
      }
    })
    expect(
      compactShutdownResult({ sessionId: 'session-1', status: 'shutdown', cells: [] })
    ).toEqual({
      sessionId: 'session-1',
      status: 'shutdown'
    })
    const createdEnvironment = compactManageEnvironmentsResult(
      {
        created: {
          name: 'env-39',
          language: 'python',
          runtimeId: '/private/runtime/envs/env-39/bin/python',
          runnable: true,
          detail: 'x'.repeat(10_000)
        },
        environments: Array.from({ length: 40 }, (_, index) => ({
          name: `env-${index}`,
          language: 'python',
          ready: true,
          isDefault: false,
          sizeBytes: 10,
          internalPath: `/private/env-${index}`
        }))
      },
      { action: 'create', offset: 30, limit: 10 }
    ) as Record<string, unknown>
    expect(createdEnvironment).not.toHaveProperty('environmentCount')
    expect(createdEnvironment).not.toHaveProperty('offset')
    expect(createdEnvironment).not.toHaveProperty('environments')
    expect(createdEnvironment).not.toHaveProperty('nextOffset')
    expect(createdEnvironment.created).toEqual({
      name: 'env-39',
      language: 'python',
      runtimeId: '/private/runtime/envs/env-39/bin/python',
      runnable: true,
      detail: expect.stringContaining('omitted from this tool response')
    })
    expect(
      compactManageEnvironmentsResult(
        { environments: [{ name: 'must-not-leak' }] },
        { action: 'create' }
      )
    ).toEqual({})

    expect(
      compactManageEnvironmentsResult(
        { removed: { name: 'env-39' }, environments: [{ name: 'stale-snapshot' }] },
        { action: 'remove' }
      )
    ).toEqual({ removed: { name: 'env-39' } })

    const listedEnvironments = compactManageEnvironmentsResult(
      {
        environments: Array.from({ length: 40 }, (_, index) => ({
          name: `env-${index}`,
          language: 'python',
          ready: true,
          isDefault: false,
          sizeBytes: 10,
          internalPath: `/private/env-${index}`
        }))
      },
      { action: 'list', offset: 30, limit: 10 }
    ) as Record<string, unknown>
    expect(listedEnvironments).toMatchObject({ offset: 30 })
    expect(listedEnvironments).not.toHaveProperty('environmentCount')
    expect(listedEnvironments.environments).toHaveLength(10)
    expect(listedEnvironments).not.toHaveProperty('nextOffset')
    expect(JSON.stringify(listedEnvironments)).toContain('env-39')
    expect(JSON.stringify(listedEnvironments)).not.toContain('internalPath')
  })

  it('keeps failed bind/switch receipts explicit about the unchanged effective target', () => {
    expect(
      compactRuntimeBindingResult({
        ok: false,
        bindingChanged: false,
        error: '"analysis" is not an enabled python runtime.',
        target: {
          language: 'python',
          selection: 'explicit-binding',
          runtimeSource: 'managed',
          environmentName: 'current-env',
          runtimeId: '/runtime/envs/current-env/bin/python',
          label: 'conda: current-env',
          prefix: '/runtime/envs/current-env'
        }
      })
    ).toEqual({
      ok: false,
      bindingChanged: false,
      error: '"analysis" is not an enabled python runtime.',
      target: {
        language: 'python',
        selection: 'explicit-binding',
        runtimeSource: 'managed',
        environmentName: 'current-env',
        runtimeId: '/runtime/envs/current-env/bin/python',
        label: 'conda: current-env',
        prefix: '/runtime/envs/current-env'
      }
    })
  })
})

describe('manage_environments tool', () => {
  const tool = NOTEBOOK_RPC_TOOLS.find((entry) => entry.name === 'manage_environments')

  it('registers manage_environments backed by the manageEnvironments RPC method', () => {
    expect(tool).toBeDefined()
    expect(tool?.method).toBe('manageEnvironments')
    expect(Object.keys(tool?.inputSchema ?? {})).toEqual(
      expect.arrayContaining(['action', 'language', 'name', 'packages', 'offset', 'limit'])
    )
    expect(tool?.description).toContain('created.runtimeId')
    expect(tool?.description).toContain('does not select')
    expect(
      NOTEBOOK_RPC_TOOLS.find((entry) => entry.name === 'notebook_bind_runtime')?.description
    ).toContain('no binding exists')
    expect(
      NOTEBOOK_RPC_TOOLS.find((entry) => entry.name === 'notebook_switch_runtime')?.description
    ).toContain('existing binding')
  })

  it('validates action enum and optional language/name/packages fields', () => {
    const schema = z.object(tool?.inputSchema ?? {})

    expect(
      schema.parse({
        action: 'create',
        language: 'python',
        name: 'my-analysis',
        packages: ['numpy']
      })
    ).toEqual({
      action: 'create',
      language: 'python',
      name: 'my-analysis',
      packages: ['numpy']
    })
    expect(schema.parse({ action: 'list' })).toEqual({ action: 'list' })
    expect(schema.parse({ action: 'remove', name: 'my-analysis' })).toEqual({
      action: 'remove',
      name: 'my-analysis'
    })
    expect(() => schema.parse({ action: 'destroy' })).toThrow()
    expect(() => schema.parse({})).toThrow()
  })

  it('forwards manage_environments input to the manageEnvironments RPC method', async () => {
    const environment = {
      endpoint: 'http://127.0.0.1:4567',
      token: 'secret-token',
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace'
    }
    const fetchCalls: Array<{ body: string }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      fetchCalls.push({ body: String(init?.body ?? '') })
      return {
        ok: true,
        json: async () => ({ result: { environments: [] } })
      } as Response
    }) as typeof fetch

    try {
      await callNotebookRpc(environment, tool?.method ?? '', { action: 'list' })

      expect(fetchCalls).toHaveLength(1)
      const body = JSON.parse(fetchCalls[0].body) as { method: string; params: { action?: string } }
      expect(body.method).toBe('manageEnvironments')
      expect(body.params.action).toBe('list')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('uses the contract doc as the manage_environments description', () => {
    expect(tool?.description).toBe(MANAGE_ENVIRONMENTS_DOC)
    expect(MANAGE_ENVIRONMENTS_DOC).toContain('action:"create"')
    expect(MANAGE_ENVIRONMENTS_DOC).toContain('action:"list"')
    expect(MANAGE_ENVIRONMENTS_DOC).toContain('action:"remove"')
    expect(MANAGE_ENVIRONMENTS_DOC).toMatch(/only action:"list".*full.*snapshot/i)
  })
})

describe('compactNotebookExecutionResult', () => {
  const runSummary = (text: {
    stdout?: string
    stderr?: string
    traceback?: string
  }): Record<string, unknown> => ({
    runId: 'notebook-run-1',
    executionInvocationId: 'invocation-1',
    status: 'completed',
    text: { stdout: '', stderr: '', traceback: '', plain: [], ...text },
    outputs: [],
    artifacts: [],
    workingFiles: []
  })

  it('applies the compact projection and global budget to every execution tool', () => {
    for (const name of ['notebook_execute', 'bash_execute']) {
      const tool = NOTEBOOK_RPC_TOOLS.find((entry) => entry.name === name)
      expect(tool?.mapResult).toBe(compactNotebookExecutionResult)
      expect(tool?.resultLimitChars).toBe(NOTEBOOK_MCP_EXECUTION_RESULT_LIMIT)
    }
    const replTool = NOTEBOOK_RPC_TOOLS.find((entry) => entry.name === 'repl_execute')
    expect(replTool?.mapResult).not.toBe(compactNotebookExecutionResult)
    expect(replTool?.resultLimitChars).toBe(NOTEBOOK_MCP_EXECUTION_RESULT_LIMIT)
  })

  it('keeps diagnostic streams once and removes duplicated structured stream outputs', () => {
    const result = {
      ...runSummary({ stdout: 'answer\n', stderr: 'warning\n' }),
      script: 'print("answer")',
      roots: { dataRoot: '/private/data' },
      outputs: [
        { type: 'stream', name: 'stdout', text: 'answer\n' },
        { type: 'stream', name: 'stderr', text: 'warning\n' },
        { type: 'display', data: { 'text/plain': '42' } }
      ]
    }

    const compact = compactNotebookExecutionResult(result) as Record<string, unknown>

    expect(compact).toMatchObject({
      executionInvocationId: 'invocation-1',
      stdout: 'answer\n',
      stderr: 'warning\n'
    })
    expect(compact).not.toHaveProperty('text')
    expect(compact).not.toHaveProperty('script')
    expect(compact).not.toHaveProperty('roots')
    expect(compact.outputs).toEqual([{ type: 'display', data: { 'text/plain': '42' } }])
  })

  it('returns dependency invalidations to the agent after execution', () => {
    const compact = compactNotebookExecutionResult({
      ...runSummary({}),
      staleness: { state: 'clear' },
      invalidatedRuns: [{ runId: 'run-2', cellId: 'make-result', names: ['df'], state: 'stale' }]
    })

    expect(compact).toMatchObject({
      staleness: { state: 'clear' },
      invalidatedRuns: [{ runId: 'run-2', cellId: 'make-result', names: ['df'], state: 'stale' }]
    })
  })

  it('bounds dependency staleness before execution-result serialization', () => {
    const compact = compactNotebookExecutionResult({
      ...runSummary({ stdout: 'done' }),
      staleness: {
        state: 'stale',
        causedByRunId: 'run-cause',
        names: Array.from({ length: 1_000 }, (_, index) => `variable-${index}`),
        path: Array.from({ length: 1_000 }, (_, index) => `run-${index}`)
      }
    })
    const serialized = serializeNotebookToolResult(compact, NOTEBOOK_MCP_EXECUTION_RESULT_LIMIT)
    const parsed = JSON.parse(serialized) as {
      preview?: string
      staleness?: { names: string[]; path: string[] }
      truncated?: boolean
    }

    expect(serialized.length).toBeLessThanOrEqual(NOTEBOOK_MCP_EXECUTION_RESULT_LIMIT)
    expect(parsed.preview).toBeUndefined()
    expect(parsed.staleness?.names.length).toBeLessThan(1_000)
    expect(parsed.staleness?.path.length).toBeLessThan(1_000)
    expect(parsed.truncated).toBe(true)
  })

  it('keeps a practical diagnostic stream inline for the next agent step', () => {
    const stdout = 'x'.repeat(7_500)

    const compact = compactNotebookExecutionResult(runSummary({ stdout })) as {
      stdout: string
      truncated?: boolean
    }

    expect(compact.stdout).toBe(stdout)
    expect(compact.truncated).toBeUndefined()
  })

  it('omits internal REPL stack frames from the agent-facing error', () => {
    const traceback = [
      'ReferenceError: en2 is not defined',
      '    at <repl>:5:21',
      '    at Script.runInContext (node:vm:149:12)',
      '    at Object.runInContext (node:vm:301:6)',
      '    at run (/Users/alice/open-science/resources/notebook/repl_loop.js:3527:28)'
    ].join('\n')

    const replTool = NOTEBOOK_RPC_TOOLS.find((entry) => entry.name === 'repl_execute')
    const summary = runSummary({ traceback })
    const raw = {
      ...summary,
      status: 'failed',
      outputs: [
        {
          type: 'error',
          message: 'ReferenceError: en2 is not defined',
          traceback
        }
      ]
    }
    const compact = replTool?.mapResult?.(raw, {}) as {
      traceback: string
      outputs: Array<Record<string, unknown>>
    }

    expect(compact.traceback).toBe('ReferenceError: en2 is not defined')
    expect(compact.outputs).toEqual([
      { type: 'error', message: 'ReferenceError: en2 is not defined' }
    ])
    expect(JSON.stringify(compact)).not.toContain('<repl>')
    expect(JSON.stringify(compact)).not.toContain('node:vm')
    expect(JSON.stringify(compact)).not.toContain('repl_loop.js')
    expect((summary.text as { traceback: string }).traceback).toBe(traceback)
    expect(raw.outputs[0].traceback).toBe(traceback)
  })

  it('keeps connector guidance while omitting host MCP stack frames from the agent-facing error', () => {
    const message =
      'Error: connector call rejected: invalid_arguments. Invalid tool arguments for biomart/get_data: field "mart" is required. Correct the arguments to match the Input schema in the loaded mcp-biomart Skill, then retry the same method once. Do not retry unchanged or bypass host.mcp.'
    const traceback = [
      message,
      '    at Object.hostMcp [as mcp] (/Users/alice/open-science/resources/notebook/repl_loop.js:1024:22)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)',
      '    at async <repl>:3:20',
      '    at async run (/Users/alice/open-science/resources/notebook/repl_loop.js:3562:19)',
      '    at async /Users/alice/open-science/resources/notebook/repl_loop.js:3608:20'
    ].join('\n')
    const replTool = NOTEBOOK_RPC_TOOLS.find((entry) => entry.name === 'repl_execute')
    const summary = runSummary({ traceback })
    const raw = {
      ...summary,
      status: 'failed',
      outputs: [{ type: 'error', message, traceback }]
    }

    const compact = replTool?.mapResult?.(raw, {}) as {
      traceback: string
      outputs: Array<Record<string, unknown>>
    }

    expect(compact.traceback).toBe(message)
    expect(compact.outputs).toEqual([{ type: 'error', message }])
    expect(JSON.stringify(compact)).not.toContain('node:internal')
    expect(JSON.stringify(compact)).not.toContain('<repl>')
    expect(JSON.stringify(compact)).not.toContain('repl_loop.js')
    expect((summary.text as { traceback: string }).traceback).toBe(traceback)
    expect(raw.outputs[0].traceback).toBe(traceback)
  })

  it('keeps the actionable SyntaxError after the VM source preamble', () => {
    const traceback = [
      '<repl>:2',
      'const value =',
      '             ^',
      '',
      'SyntaxError: Unexpected end of input',
      '    at new Script (node:vm:117:7)',
      '    at Object.runInContext (node:vm:301:6)',
      '    at run (/Users/alice/open-science/resources/notebook/repl_loop.js:3527:28)'
    ].join('\n')
    const replTool = NOTEBOOK_RPC_TOOLS.find((entry) => entry.name === 'repl_execute')

    const compact = replTool?.mapResult?.(
      { ...runSummary({ traceback }), status: 'failed' },
      {}
    ) as { traceback: string }

    expect(compact.traceback).toBe('SyntaxError: Unexpected end of input')
  })

  it('preserves multiline REPL error messages while omitting stack frames', () => {
    const traceback = [
      'Error: first diagnostic line',
      '    at the lab, review the second diagnostic line',
      'third diagnostic line',
      '    at <repl>:1:7',
      '    at run (/Users/alice/open-science/resources/notebook/repl_loop.js:3527:28)'
    ].join('\n')
    const replTool = NOTEBOOK_RPC_TOOLS.find((entry) => entry.name === 'repl_execute')

    const compact = replTool?.mapResult?.(
      { ...runSummary({ traceback }), status: 'failed' },
      {}
    ) as { traceback: string }

    expect(compact.traceback).toBe(
      'Error: first diagnostic line\n    at the lab, review the second diagnostic line\nthird diagnostic line'
    )
  })

  it('keeps Python tracebacks intact for the agent', () => {
    const traceback =
      'Traceback (most recent call last):\n  File "analysis.py", line 2\nValueError: boom'

    const compact = compactNotebookExecutionResult({
      ...runSummary({ traceback }),
      kernelKind: 'python',
      status: 'failed'
    }) as { traceback: string }

    expect(compact.traceback).toBe(traceback)
  })

  it('corrects imports of injected figure Skill helpers without suggesting package installation', () => {
    const kernelSkillIds = ['figure-style', 'figure-composer', 'paper-narrative']

    for (const [skillId, moduleName] of [
      ['figure-style', 'figure_style'],
      ['figure-composer', 'figure_composer'],
      ['paper-narrative', 'paper_narrative']
    ] as const) {
      const traceback = [
        'Traceback (most recent call last):',
        '  File "<cell>", line 3, in <module>',
        `ModuleNotFoundError: No module named '${moduleName}'`
      ].join('\n')

      const compact = compactNotebookExecutionResult(
        {
          ...runSummary({ traceback }),
          kernelKind: 'python',
          status: 'failed'
        },
        { kernelSkillIds }
      ) as { hint?: string; traceback: string }

      expect(compact.traceback).toBe(traceback)
      expect(compact.hint).toContain(`Kernel Skill "${skillId}"`)
      expect(compact.hint).toContain('not a Python package')
      expect(compact.hint).toContain(
        'kernelSkillIds: ["figure-style","figure-composer","paper-narrative"]'
      )
      expect(compact.hint).toContain('call its exported functions directly')
      expect(compact.hint).toContain(`Do not install ${moduleName}`)
    }

    const ordinaryMissingPackage = compactNotebookExecutionResult(
      {
        ...runSummary({
          traceback: [
            'Traceback (most recent call last):',
            '  File "<cell>", line 1, in <module>',
            "ModuleNotFoundError: No module named 'pandas'"
          ].join('\n')
        }),
        kernelKind: 'python',
        status: 'failed'
      },
      { kernelSkillIds }
    ) as { hint?: string }
    expect(ordinaryMissingPackage.hint).toBeUndefined()

    const helperInternalFailure = compactNotebookExecutionResult(
      {
        ...runSummary({
          traceback: [
            'Traceback (most recent call last):',
            '  File "<cell>", line 1, in <module>',
            '  File "<open-science-helper:figure-style>", line 2, in apply_figure_style',
            "ModuleNotFoundError: No module named 'figure_style'"
          ].join('\n')
        }),
        kernelKind: 'python',
        status: 'failed'
      },
      { kernelSkillIds }
    ) as { hint?: string }
    expect(helperInternalFailure.hint).toBeUndefined()

    const unverifiedCustomHelper = compactNotebookExecutionResult(
      {
        ...runSummary({
          traceback: [
            'Traceback (most recent call last):',
            '  File "<cell>", line 1, in <module>',
            "ModuleNotFoundError: No module named 'foo_bar'"
          ].join('\n')
        }),
        kernelKind: 'python',
        status: 'failed'
      },
      { kernelSkillIds: ['foo-bar'] }
    ) as { hint?: string }
    expect(unverifiedCustomHelper.hint).toBeUndefined()
  })

  it('preserves producer truncation when no additional MCP clipping is needed', () => {
    const compact = compactNotebookExecutionResult({
      ...runSummary({ stdout: 'retained prefix' }),
      truncated: true
    }) as { truncated?: boolean; note?: string }

    expect(compact.truncated).toBe(true)
    expect(compact.note).toContain('during capture')
  })

  it('keeps a practical connector trailing result inline', () => {
    const text = 'x'.repeat(7_500)
    const compact = compactNotebookExecutionResult({
      ...runSummary({}),
      outputs: [{ type: 'display', data: { 'text/plain': text } }]
    }) as { outputs: Array<{ data: Record<string, string> }>; truncated?: boolean }

    expect(compact.outputs[0].data['text/plain']).toBe(text)
    expect(compact.truncated).toBeUndefined()
  })

  it('elides an image display output while preserving its notebook-preview marker', () => {
    const base64 = 'A'.repeat(60_000)
    const result = {
      ...runSummary({ stdout: 'done' }),
      outputs: [{ type: 'display', data: { 'image/png': base64, 'text/plain': 'small' } }]
    }

    const compact = compactNotebookExecutionResult(result) as {
      outputs: { data: Record<string, string> }[]
    }

    expect(compact.outputs[0].data['image/png']).toContain('image/png')
    expect(compact.outputs[0].data['image/png']).toContain('omitted')
    expect(compact.outputs[0].data['image/png'].length).toBeLessThan(200)
    expect(compact.outputs[0].data['text/plain']).toBe('small')
    const serialized = JSON.stringify(compact)
    expect(serialized.length).toBeLessThan(2_000)
    expect(() => JSON.parse(serialized)).not.toThrow()
    expect(result.outputs[0].data['image/png'].length).toBe(60_000)
  })

  it('applies a global execution-result budget to multiple large fields', () => {
    const oversized = Array.from({ length: 100_000 }, (_, index) => `${index % 10}`).join('')
    const result = {
      status: 'completed',
      executionInvocationId: 'invocation-1',
      environment: oversized,
      stdout: oversized,
      stderr: oversized,
      traceback: oversized,
      outputs: [
        { type: 'stream', name: 'stdout', text: oversized },
        { type: 'json', data: { value: oversized } }
      ]
    }

    const serialized = serializeNotebookToolResult(
      compactNotebookExecutionResult(result),
      NOTEBOOK_MCP_EXECUTION_RESULT_LIMIT
    )

    expect(NOTEBOOK_MCP_EXECUTION_RESULT_LIMIT).toBe(24_000)
    expect(serialized.length).toBeLessThanOrEqual(NOTEBOOK_MCP_EXECUTION_RESULT_LIMIT)
    expect(tokenizer.encode(serialized).length).toBeLessThanOrEqual(8_000)
    expect(JSON.parse(serialized)).toMatchObject({
      status: 'completed',
      executionInvocationId: 'invocation-1',
      truncated: true
    })
    expect(result.stdout.length).toBe(oversized.length)
  })

  it('passes through payloads that are neither run summaries nor state', () => {
    expect(compactNotebookExecutionResult(null)).toBeNull()
    expect(compactNotebookExecutionResult('plain')).toBe('plain')
  })
})

describe('compactNotebookStateResult', () => {
  it('applies the state projection and smaller global budget to notebook_state', () => {
    const tool = NOTEBOOK_RPC_TOOLS.find((entry) => entry.name === 'notebook_state')
    expect(tool?.mapResult).toBe(compactNotebookStateResult)
    expect(tool?.resultLimitChars).toBe(NOTEBOOK_MCP_STATE_RESULT_LIMIT)
  })

  it('returns bounded recent metadata without duplicating the complete run history', () => {
    const runs = Array.from({ length: 20 }, (_, index) => ({
      runId: `run-${index}`,
      cellId: `cell-${index}`,
      kernelKind: 'python',
      status: 'completed',
      truncated: index === 19,
      startedAt: index,
      endedAt: index + 1,
      script: 'print(1)'.repeat(10_000),
      text: {
        stdout: `output-${index}`.repeat(10_000),
        stderr: '',
        traceback: '',
        plain: []
      },
      outputs: [{ type: 'stream', name: 'stdout', text: `output-${index}`.repeat(10_000) }]
    }))
    const state = {
      sessionId: 'session-1',
      kernelStatus: 'idle',
      cwd: '/workspace',
      dataRoot: '/workspace/data',
      runCount: 125,
      cells: [
        { id: 'cell-19', language: 'python', code: 'x'.repeat(100_000), status: 'completed' }
      ],
      runs,
      recentRuns: runs,
      environments: [],
      runtimeBindings: {}
    }

    const compact = compactNotebookStateResult(state) as Record<string, unknown>
    const serialized = serializeNotebookToolResult(compact, NOTEBOOK_MCP_STATE_RESULT_LIMIT)
    const parsed = JSON.parse(serialized) as Record<string, unknown>

    expect(serialized.length).toBeLessThanOrEqual(NOTEBOOK_MCP_STATE_RESULT_LIMIT)
    expect(tokenizer.encode(serialized).length).toBeLessThanOrEqual(2_000)
    expect(parsed).not.toHaveProperty('runs')
    expect(parsed).toHaveProperty('runCount', 125)
    expect((parsed.recentRuns as unknown[]).length).toBe(10)
    expect(serialized).not.toContain('print(1)')
    expect(serialized).not.toContain('outputs')
    expect(serialized).not.toContain('code')
    expect(serialized).toContain('output-19')
    expect(parsed.recentRuns).toEqual(
      expect.arrayContaining([expect.objectContaining({ runId: 'run-19', truncated: true })])
    )
  })

  it('keeps the latest successful text result available for recovery', () => {
    const state = {
      sessionId: 'session-1',
      runs: [
        {
          runId: 'run-1',
          status: 'completed',
          text: { stdout: '', stderr: '', traceback: '', plain: [] },
          outputs: [{ type: 'display', data: { 'text/plain': 'older result' } }]
        },
        {
          runId: 'run-2',
          status: 'completed',
          text: { stdout: '', stderr: '', traceback: '', plain: [] },
          outputs: [
            {
              type: 'display',
              data: { 'text/plain': '{"total_count":42}', 'image/png': 'A'.repeat(60_000) }
            }
          ]
        }
      ]
    }

    const compact = compactNotebookStateResult(state) as {
      recentRuns: Array<Record<string, unknown>>
    }

    expect(compact.recentRuns[0]).not.toHaveProperty('outputPreview')
    expect(compact.recentRuns[1]).toHaveProperty('outputPreview', '{"total_count":42}')
    expect(JSON.stringify(compact)).not.toContain('image/png')
  })

  it('keeps REPL connector guidance without exposing its host stack through notebook_state', () => {
    const message =
      'Error: connector call rejected: invalid_arguments. Invalid tool arguments for biomart/get_data: field "mart" is required. Correct the arguments to match the Input schema in the loaded mcp-biomart Skill, then retry the same method once. Do not retry unchanged or bypass host.mcp.'
    const traceback = [
      message,
      '    at Object.hostMcp [as mcp] (/Users/alice/open-science/resources/notebook/repl_loop.js:1024:22)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)',
      '    at async <repl>:3:20',
      '    at async run (/Users/alice/open-science/resources/notebook/repl_loop.js:3562:19)'
    ].join('\n')
    const state = {
      sessionId: 'session-1',
      runs: [
        {
          runId: 'run-1',
          kernelKind: 'repl',
          status: 'failed',
          text: { stdout: '', stderr: '', traceback, plain: [] }
        }
      ]
    }

    const compact = compactNotebookStateResult(state) as {
      recentRuns: Array<{ outputPreview?: string }>
    }
    const serialized = JSON.stringify(compact)

    expect(compact.recentRuns[0].outputPreview).toBe(message)
    expect(serialized).not.toContain('node:internal')
    expect(serialized).not.toContain('<repl>')
    expect(serialized).not.toContain('repl_loop.js')
    expect(state.runs[0].text.traceback).toBe(traceback)
  })

  it('bounds dependency staleness on compact recent runs', () => {
    const recentRuns = Array.from({ length: 10 }, (_, index) => ({
      runId: `run-${index}`,
      cellId: `cell-${index}`,
      status: 'completed'
    }))
    const runStaleness = Object.fromEntries(
      recentRuns.map((run) => [
        run.runId,
        {
          state: 'stale',
          causedByRunId: 'run-cause',
          names: Array.from({ length: 1_000 }, (_, index) => `variable-${index}`),
          path: Array.from({ length: 1_000 }, (_, index) => `run-${index}`)
        }
      ])
    )
    const compact = compactNotebookStateResult({
      sessionId: 'session-1',
      runs: recentRuns,
      recentRuns,
      runStaleness
    })
    const serialized = serializeNotebookToolResult(compact, NOTEBOOK_MCP_STATE_RESULT_LIMIT)
    const parsed = JSON.parse(serialized) as {
      preview?: string
      recentRuns?: Array<{ staleness?: { names: string[]; path: string[] } }>
    }

    expect(serialized.length).toBeLessThanOrEqual(NOTEBOOK_MCP_STATE_RESULT_LIMIT)
    expect(parsed.preview).toBeUndefined()
    expect(parsed.recentRuns).toHaveLength(10)
    expect(parsed.recentRuns?.[0]?.staleness?.names.length).toBeLessThan(1_000)
    expect(parsed.recentRuns?.[0]?.staleness?.path.length).toBeLessThan(1_000)
  })

  it('passes through non-object state results', () => {
    expect(compactNotebookStateResult(null)).toBeNull()
    expect(compactNotebookStateResult('plain')).toBe('plain')
  })

  it('enforces the state budget when runtime metadata is unexpectedly large', () => {
    const state = compactNotebookStateResult({
      sessionId: 'session-1',
      kernelStatus: 'idle',
      cells: [],
      runs: [],
      recentRuns: [],
      runtimeBindings: { python: { runtimeId: 'x'.repeat(100_000) } }
    })
    const serialized = serializeNotebookToolResult(state, NOTEBOOK_MCP_STATE_RESULT_LIMIT)

    expect(serialized.length).toBeLessThanOrEqual(NOTEBOOK_MCP_STATE_RESULT_LIMIT)
    expect(tokenizer.encode(serialized).length).toBeLessThanOrEqual(2_000)
    expect(JSON.parse(serialized)).toMatchObject({
      sessionId: 'session-1',
      kernelStatus: 'idle',
      truncated: true
    })
  })
})

describe('compactRestartResult', () => {
  it('reduces a full session state to a compact restart confirmation', () => {
    const state = {
      sessionId: 's1',
      kernelStatus: 'idle',
      cells: [{ id: 'c1' }, { id: 'c2' }],
      runs: [{ runId: 'r1', script: 'x'.repeat(5000) }],
      recentRuns: [{ runId: 'r1' }]
    }

    const compact = compactRestartResult(state) as Record<string, unknown>

    expect(compact.sessionId).toBe('s1')
    expect(compact.kernelStatus).toBe('idle')
    expect(compact.status).toBe('restarted')
    expect(compact.cells).toBe(2)
    expect(String(compact.note)).toContain('restarted')
    // The verbose run history is NOT carried into the agent-facing restart result.
    const serialized = JSON.stringify(compact)
    expect(serialized).not.toContain('runs')
    expect(serialized).not.toContain('script')
    expect(serialized.length).toBeLessThan(400)
  })

  it('passes through a non-object restart result unchanged', () => {
    expect(compactRestartResult(null)).toBeNull()
    expect(compactRestartResult('x')).toBe('x')
  })
})
