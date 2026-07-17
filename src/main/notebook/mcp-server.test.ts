import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  BASH_EXECUTE_DOC,
  MANAGE_ENVIRONMENTS_DOC,
  MANAGE_PACKAGES_DOC,
  NOTEBOOK_MCP_OUTPUT_FIELD_LIMIT,
  REPL_EXECUTE_DOC,
  NOTEBOOK_RPC_TOOLS,
  NOTEBOOK_SYSTEM_PROMPT_APPEND,
  callNotebookRpc,
  compactRestartResult,
  createNotebookMcpServerConfig,
  truncateNotebookRunResult
} from './mcp-server'

describe('notebook MCP server config', () => {
  it('builds an ACP stdio MCP server config scoped to the notebook runtime RPC endpoint', () => {
    const config = createNotebookMcpServerConfig({
      command: '/Applications/Open Science.app/Contents/MacOS/Open Science',
      entryPath: '/app/out/main/index.js',
      endpoint: 'http://127.0.0.1:4567',
      token: 'secret-token',
      projectName: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace'
    })

    expect(config).toEqual({
      name: 'open-science-notebook',
      command: '/Applications/Open Science.app/Contents/MacOS/Open Science',
      args: ['/app/out/main/index.js', '--open-science-notebook-mcp'],
      env: [
        { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
        { name: 'OPEN_SCIENCE_NOTEBOOK_RPC_ENDPOINT', value: 'http://127.0.0.1:4567' },
        { name: 'OPEN_SCIENCE_NOTEBOOK_RPC_TOKEN', value: 'secret-token' },
        { name: 'OPEN_SCIENCE_NOTEBOOK_PROJECT_NAME', value: 'default-project' },
        { name: 'OPEN_SCIENCE_NOTEBOOK_SESSION_ID', value: 'session-1' },
        { name: 'OPEN_SCIENCE_NOTEBOOK_WORKSPACE_CWD', value: '/workspace' }
      ]
    })
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
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('write_artifact_file')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('open-science-artifacts')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('"kind": "localPath"')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).not.toContain(
      'for binary final outputs, read base64 content'
    )
  })

  it('directs the agent to run code as one notebook_execute call per cell', () => {
    // The single-step execute tool keeps each cell to one permission prompt and one activity row,
    // instead of the old begin/append/finish/run streaming sequence.
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('notebook_execute')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).not.toContain('append code deltas')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).not.toContain('finish the cell')
  })

  it('exposes only the single-step execute tool for writing and running code', () => {
    const toolNames = NOTEBOOK_RPC_TOOLS.map((tool) => tool.name)

    expect(toolNames).toContain('notebook_execute')
    expect(toolNames).not.toContain('notebook_begin_code_cell')
    expect(toolNames).not.toContain('notebook_append_code_cell')
    expect(toolNames).not.toContain('notebook_finish_code_cell')
    expect(toolNames).not.toContain('notebook_run_cell')
  })

  it('exposes manage_environments and explains named environments are separate namespaces', () => {
    const toolNames = NOTEBOOK_RPC_TOOLS.map((tool) => tool.name)
    expect(toolNames).toContain('manage_environments')

    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('manage_environments')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('./handoff/')
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND.toLowerCase()).toContain('separate')
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

  it('accepts an optional environment name selecting a named persistent environment', () => {
    expect(tool).toBeDefined()
    const schema = z.object(tool?.inputSchema ?? {})

    expect(schema.parse({ code: 'print(1)', environment: 'my-analysis' })).toEqual({
      code: 'print(1)',
      environment: 'my-analysis'
    })
    // Omitted environment still validates — resolution to the default happens on the RPC side.
    expect(schema.parse({ code: 'print(1)' })).toEqual({ code: 'print(1)' })
  })

  it('describes environment as a separate namespace requiring manage_environments to create', () => {
    expect(tool?.description).toContain('environment')
    expect(tool?.description).toContain('SEPARATE')
    expect(tool?.description).toContain('manage_environments')
  })

  it('forwards the selected language straight through to the execute RPC call', async () => {
    const environment = {
      endpoint: 'http://127.0.0.1:4567',
      token: 'secret-token',
      projectName: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace'
    }
    // The MCP tool handler passes schema-validated input straight to callNotebookRpc as the
    // RPC params, so asserting the call helper forwards `language` covers the handler wiring.
    const fetchCalls: Array<{ body: string }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      fetchCalls.push({ body: String(init?.body ?? '') })
      return {
        ok: true,
        json: async () => ({ result: { ok: true } })
      } as Response
    }) as typeof fetch

    try {
      const result = await callNotebookRpc(environment, 'execute', {
        code: '1 + 1',
        language: 'r'
      })

      expect(result).toEqual({ ok: true })
      expect(fetchCalls).toHaveLength(1)
      const sentBody = JSON.parse(fetchCalls[0].body) as { params: { language?: string } }
      expect(sentBody.params.language).toBe('r')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('repl_execute tool', () => {
  const tool = NOTEBOOK_RPC_TOOLS.find((entry) => entry.name === 'repl_execute')

  it('registers repl_execute backed by the executeControl RPC method with a code/timeoutMs schema', () => {
    expect(tool).toBeDefined()
    expect(tool?.method).toBe('executeControl')

    const schema = z.object(tool?.inputSchema ?? {})
    expect(schema.parse({ code: 'return 1' })).toEqual({ code: 'return 1' })
    expect(schema.parse({ code: 'return 1', timeoutMs: 5000 })).toEqual({
      code: 'return 1',
      timeoutMs: 5000
    })
    expect(() => schema.parse({})).toThrow()
    // The control-plane repl takes no language/cellId — it is distinct from notebook_execute.
    expect(Object.keys(tool?.inputSchema ?? {})).toEqual(['code', 'timeoutMs'])
  })

  it('describes the control-plane repl (host.mcp + handoff) distinctly from notebook_execute', () => {
    expect(tool?.description).toBe(REPL_EXECUTE_DOC)
    expect(tool?.description).toContain('host.mcp')
    expect(tool?.description).toContain('./handoff/')
    expect(tool?.description.toLowerCase()).toContain('connector')
    expect(tool?.description).toContain('notebook_execute')
  })

  it('forwards repl_execute input to the executeControl RPC method', async () => {
    const environment = {
      endpoint: 'http://127.0.0.1:4567',
      token: 'secret-token',
      projectName: 'default-project',
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

  it('forwards bash_execute input to the executeShell RPC method', async () => {
    const environment = {
      endpoint: 'http://127.0.0.1:4567',
      token: 'secret-token',
      projectName: 'default-project',
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
    expect(Object.keys(tool?.inputSchema ?? {})).toEqual(
      expect.arrayContaining(['language', 'packages', 'usePip', 'channels', 'environment'])
    )
  })

  it('accepts an optional environment name targeting a named environment', () => {
    const schema = z.object(tool?.inputSchema ?? {})

    expect(
      schema.parse({ language: 'python', packages: ['numpy'], environment: 'my-analysis' })
    ).toEqual({ language: 'python', packages: ['numpy'], environment: 'my-analysis' })
    // Omitted environment still validates.
    expect(schema.parse({ language: 'python', packages: ['numpy'] })).toEqual({
      language: 'python',
      packages: ['numpy']
    })
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
    expect(doc).toContain('manage_environments')
    expect(doc).toMatch(/report .*user|tell the user/i)
  })

  it('uses the contract doc as the tool description so the agent sees it', () => {
    expect(tool?.description).toBe(MANAGE_PACKAGES_DOC)
  })

  it('points the notebook system prompt at manage_packages as the only install path', () => {
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('manage_packages')
  })
})

describe('manage_environments tool', () => {
  const tool = NOTEBOOK_RPC_TOOLS.find((entry) => entry.name === 'manage_environments')

  it('registers manage_environments backed by the manageEnvironments RPC method', () => {
    expect(tool).toBeDefined()
    expect(tool?.method).toBe('manageEnvironments')
    expect(Object.keys(tool?.inputSchema ?? {})).toEqual(
      expect.arrayContaining(['action', 'language', 'name', 'packages'])
    )
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

  it('uses the contract doc as the tool description so the agent sees it', () => {
    expect(tool?.description).toBe(MANAGE_ENVIRONMENTS_DOC)
  })

  it('describes create/list/remove semantics, defaults protection, and no connector access', () => {
    const doc = MANAGE_ENVIRONMENTS_DOC
    expect(doc).toContain('action:"create"')
    expect(doc).toContain('action:"list"')
    expect(doc).toContain('action:"remove"')
    expect(doc).toMatch(/default-python|defaults/i)
    expect(doc.toLowerCase()).toContain('restart')
    expect(doc).toContain('notebook_execute')
    expect(doc).toContain('manage_packages')
    expect(doc.toLowerCase()).toContain('host.mcp')
  })

  it('forwards manage_environments input to the manageEnvironments RPC method', async () => {
    const environment = {
      endpoint: 'http://127.0.0.1:4567',
      token: 'secret-token',
      projectName: 'default-project',
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
})

describe('truncateNotebookRunResult', () => {
  const runSummary = (text: {
    stdout?: string
    stderr?: string
    traceback?: string
  }): Record<string, unknown> => ({
    runId: 'notebook-run-1',
    status: 'completed',
    text: { stdout: '', stderr: '', traceback: '', plain: [], ...text },
    outputs: [],
    artifacts: [],
    workingFiles: []
  })

  it('returns a run summary untouched when every stream is under the limit', () => {
    const result = runSummary({ stdout: 'small output' })

    const truncated = truncateNotebookRunResult(result)

    expect(truncated).toBe(result)
    expect(truncated).not.toHaveProperty('truncated')
  })

  it('clips an oversized stream, marks it truncated, and keeps the JSON parseable', () => {
    const oversized = 'x'.repeat(NOTEBOOK_MCP_OUTPUT_FIELD_LIMIT + 5_000)
    const result = runSummary({ stdout: oversized })

    const truncated = truncateNotebookRunResult(result) as {
      truncated?: boolean
      text: { stdout: string; stderr: string }
    }

    expect(truncated.truncated).toBe(true)
    expect(truncated.text.stdout.length).toBeLessThan(oversized.length)
    expect(truncated.text.stdout).toContain('truncated 5000 chars')
    // Streams under the limit are left alone.
    expect(truncated.text.stderr).toBe('')
    // The serialized payload the agent receives is still valid JSON.
    expect(() => JSON.parse(JSON.stringify(truncated))).not.toThrow()
    // The original object is not mutated.
    expect((result.text as { stdout: string }).stdout).toBe(oversized)
  })

  it('clips each oversized stream independently', () => {
    const oversized = 'y'.repeat(NOTEBOOK_MCP_OUTPUT_FIELD_LIMIT + 1)
    const result = runSummary({ stdout: oversized, traceback: oversized })

    const truncated = truncateNotebookRunResult(result) as {
      truncated?: boolean
      text: { stdout: string; traceback: string }
    }

    expect(truncated.truncated).toBe(true)
    expect(truncated.text.stdout).toContain('truncated')
    expect(truncated.text.traceback).toContain('truncated')
  })

  it('elides an image display output to a marker and marks the run truncated', () => {
    const base64 = 'A'.repeat(60_000)
    const result = {
      ...runSummary({ stdout: 'done' }),
      outputs: [{ type: 'display', data: { 'image/png': base64, 'text/plain': 'small' } }]
    }

    const truncated = truncateNotebookRunResult(result) as {
      truncated?: boolean
      outputs: { data: Record<string, string> }[]
    }

    expect(truncated.truncated).toBe(true)
    // The base64 image is replaced with a compact marker...
    expect(truncated.outputs[0].data['image/png']).toContain('image/png')
    expect(truncated.outputs[0].data['image/png']).toContain('omitted')
    expect(truncated.outputs[0].data['image/png'].length).toBeLessThan(200)
    // ...while a small text mime stays inline.
    expect(truncated.outputs[0].data['text/plain']).toBe('small')
    // The serialized payload the agent receives is tiny and valid JSON.
    const serialized = JSON.stringify(truncated)
    expect(serialized.length).toBeLessThan(2_000)
    expect(() => JSON.parse(serialized)).not.toThrow()
    // The original object is not mutated.
    expect(result.outputs[0].data['image/png'].length).toBe(60_000)
  })

  it('elides image outputs inside a state result run history', () => {
    const base64 = 'B'.repeat(60_000)
    const state = {
      kernelStatus: 'idle',
      runs: [
        {
          runId: 'r1',
          text: { stdout: '', stderr: '', traceback: '', plain: [] },
          outputs: [{ type: 'display', data: { 'image/png': base64 } }]
        }
      ],
      recentRuns: []
    }

    const truncated = truncateNotebookRunResult(state) as {
      runs: { outputs: { data: Record<string, string> }[] }[]
    }

    expect(truncated.runs[0].outputs[0].data['image/png']).toContain('omitted')
    expect(JSON.stringify(truncated).length).toBeLessThan(2_000)
  })

  it('clips a top-level stdout on a repl_execute/bash control result and its outputs', () => {
    const oversized = 'z'.repeat(NOTEBOOK_MCP_OUTPUT_FIELD_LIMIT + 90_000)
    // The control-plane result shape: stdout/stderr/traceback are top-level (no `text` object).
    const result = {
      status: 'completed',
      stdout: oversized,
      stderr: '',
      traceback: '',
      outputs: [{ type: 'stream', name: 'stdout', text: oversized }]
    }

    const truncated = truncateNotebookRunResult(result) as {
      truncated?: boolean
      stdout: string
      outputs: { text: string }[]
    }

    expect(truncated.truncated).toBe(true)
    expect(truncated.stdout.length).toBeLessThan(oversized.length)
    expect(truncated.stdout).toContain('truncated')
    // The duplicated stream output is clipped too.
    expect(truncated.outputs[0].text.length).toBeLessThan(oversized.length)
    // The whole serialized payload is now well under the tool-result budget.
    expect(JSON.stringify(truncated).length).toBeLessThan(NOTEBOOK_MCP_OUTPUT_FIELD_LIMIT * 3)
    // Original not mutated.
    expect(result.stdout.length).toBe(oversized.length)
  })

  it('clips a bash_execute result with a large stdout and no `text` object', () => {
    const oversized = 'w'.repeat(NOTEBOOK_MCP_OUTPUT_FIELD_LIMIT + 1)
    const result = { stdout: oversized, stderr: '', exitCode: 0 }

    const truncated = truncateNotebookRunResult(result) as { truncated?: boolean; stdout: string }

    expect(truncated.truncated).toBe(true)
    expect(truncated.stdout).toContain('truncated')
  })

  it('passes through payloads that are neither run summaries nor state', () => {
    const other = { cells: [], kernelStatus: 'idle' }

    expect(truncateNotebookRunResult(other)).toBe(other)
    expect(truncateNotebookRunResult(null)).toBeNull()
    expect(truncateNotebookRunResult('plain')).toBe('plain')
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
