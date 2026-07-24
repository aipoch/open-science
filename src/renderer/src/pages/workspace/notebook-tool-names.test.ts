import { describe, expect, it } from 'vitest'

import { isNotebookExecuteToolName, matchNotebookRunTool } from './notebook-tool-names'

describe('isNotebookExecuteToolName', () => {
  it('matches the notebook server run tools in Claude Code mcp__ form', () => {
    expect(isNotebookExecuteToolName('mcp__open-science-notebook__notebook_execute')).toBe(true)
    expect(isNotebookExecuteToolName('mcp__open-science-notebook__repl_execute')).toBe(true)
    expect(isNotebookExecuteToolName('mcp__open-science-notebook__bash_execute')).toBe(true)
  })

  it('matches the dotted <server>.<tool> form used by other frameworks', () => {
    expect(isNotebookExecuteToolName('open-science-notebook.notebook_execute')).toBe(true)
    // The exact broker-produced namespaced title.
    expect(isNotebookExecuteToolName('mcp.open-science-notebook.notebook_execute')).toBe(true)
  })

  it('does not match the bare leaf name alone (no server segment to verify)', () => {
    // The dialog must consult the namespaced title too, not rely on this leaf.
    expect(isNotebookExecuteToolName('notebook_execute')).toBe(false)
  })

  it('matches the underscore-sanitized server form from the responses bridge', () => {
    // The bridge sanitizes the server name to open_science_notebook; normalization must accept it.
    expect(isNotebookExecuteToolName('mcp__open_science_notebook__notebook_execute')).toBe(true)
    expect(isNotebookExecuteToolName('mcp__open_science_notebook__bash_execute')).toBe(true)
  })

  it('matches the opencode single-underscore <server>_<tool> form', () => {
    // opencode joins server and tool with a single underscore, no mcp__ prefix.
    expect(isNotebookExecuteToolName('open-science-notebook_notebook_execute')).toBe(true)
    expect(isNotebookExecuteToolName('open-science-notebook_repl_execute')).toBe(true)
    expect(isNotebookExecuteToolName('open_science_notebook_bash_execute')).toBe(true)
  })

  it('rejects opencode-style lookalikes with a different server', () => {
    expect(isNotebookExecuteToolName('open-science-notebook-staging_notebook_execute')).toBe(false)
    expect(isNotebookExecuteToolName('my-open-science-notebook_notebook_execute')).toBe(false)
    expect(isNotebookExecuteToolName('acme-db_notebook_execute')).toBe(false)
  })

  it('rejects a lookalike suffix from a different MCP server', () => {
    // Same suffix, wrong server — must not be treated as the trusted notebook integration.
    expect(isNotebookExecuteToolName('mcp__acme-db__notebook_execute')).toBe(false)
  })

  it('rejects a server name that merely contains the notebook phrase', () => {
    // Exact server-segment match: a staging/proxy variant is a different server, not the notebook.
    expect(isNotebookExecuteToolName('mcp__open-science-notebook-staging__notebook_execute')).toBe(
      false
    )
    expect(isNotebookExecuteToolName('mcp__my-open-science-notebook__notebook_execute')).toBe(false)
  })

  it('returns the matched suffix so callers can narrow to a specific kernel tool', () => {
    expect(matchNotebookRunTool('mcp__open-science-notebook__notebook_execute')).toBe(
      'notebook_execute'
    )
    expect(matchNotebookRunTool('mcp__open_science_notebook__repl_execute')).toBe('repl_execute')
    expect(matchNotebookRunTool('mcp__acme-db__notebook_execute')).toBeUndefined()
  })

  it('rejects notebook server tools that are not kernel-run tools', () => {
    expect(isNotebookExecuteToolName('mcp__open-science-notebook__notebook_state')).toBe(false)
  })

  it('rejects empty or missing names', () => {
    expect(isNotebookExecuteToolName('')).toBe(false)
    expect(isNotebookExecuteToolName(undefined)).toBe(false)
    expect(isNotebookExecuteToolName(null)).toBe(false)
  })
})
