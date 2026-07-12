import { describe, expect, it } from 'vitest'

import {
  NOTEBOOK_RPC_TOOLS,
  NOTEBOOK_SYSTEM_PROMPT_APPEND,
  createNotebookMcpServerConfig
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
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toContain(
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
