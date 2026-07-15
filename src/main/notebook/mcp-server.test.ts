import { describe, expect, it } from 'vitest'

import {
  NOTEBOOK_MCP_OUTPUT_FIELD_LIMIT,
  NOTEBOOK_RPC_TOOLS,
  NOTEBOOK_SYSTEM_PROMPT_APPEND,
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
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain('~/.open-science/runtime/')
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

  it('passes through payloads that are not run summaries', () => {
    const state = { cells: [], recentRuns: [], kernelStatus: 'idle' }

    expect(truncateNotebookRunResult(state)).toBe(state)
    expect(truncateNotebookRunResult(null)).toBeNull()
    expect(truncateNotebookRunResult('plain')).toBe('plain')
  })
})
