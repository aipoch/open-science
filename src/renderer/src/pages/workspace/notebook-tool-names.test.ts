import { describe, expect, it } from 'vitest'

import {
  isNotebookExecuteToolName,
  isNotebookManagePackagesToolName,
  matchNotebookControlTool,
  matchNotebookMemoryTool,
  matchNotebookRunTool
} from './notebook-tool-names'

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
    expect(isNotebookExecuteToolName('open-science-notebook/notebook_execute')).toBe(true)
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

  it('matches notebook controls with the same exact server boundary', () => {
    expect(matchNotebookControlTool('mcp__open-science-notebook__notebook_restart')).toBe(
      'notebook_restart'
    )
    expect(matchNotebookControlTool('open_science_notebook_notebook_shutdown')).toBe(
      'notebook_shutdown'
    )
    expect(matchNotebookControlTool('mcp__open-science-notebook__inspect_packages')).toBe(
      'inspect_packages'
    )
    expect(matchNotebookControlTool('mcp__acme-db__notebook_restart')).toBeUndefined()
  })

  it('matches manage_packages only for the canonical notebook server', () => {
    expect(isNotebookManagePackagesToolName('open-science-notebook.manage_packages')).toBe(true)
    expect(isNotebookManagePackagesToolName('mcp__open_science_notebook__manage_packages')).toBe(
      true
    )
    expect(isNotebookManagePackagesToolName('mcp__acme-db__manage_packages')).toBe(false)
    expect(isNotebookManagePackagesToolName('manage_packages')).toBe(false)
  })

  it('matches memory tools only for the canonical notebook server', () => {
    expect(matchNotebookMemoryTool('mcp__open-science-notebook__list_memory_categories')).toBe(
      'list_memory_categories'
    )
    expect(matchNotebookMemoryTool('mcp__open_science_notebook__search_memories')).toBe(
      'search_memories'
    )
    expect(matchNotebookMemoryTool('mcp.open-science-notebook.remember_memory')).toBe(
      'remember_memory'
    )
    expect(
      matchNotebookMemoryTool('mcp__open-science-notebook-staging__remember_memory')
    ).toBeUndefined()
    expect(matchNotebookMemoryTool('mcp__acme-db__remember_memory')).toBeUndefined()
  })

  it.each([
    ['open-science-notebook/list_memory_categories', 'list_memory_categories'],
    ['open_science_notebook/list_memory_categories', 'list_memory_categories'],
    ['open-science-notebook_search_memories', 'search_memories'],
    ['open_science_notebook_search_memories', 'search_memories'],
    ['open-science-notebook_remember_memory', 'remember_memory'],
    ['open_science_notebook_remember_memory', 'remember_memory']
  ] as const)('matches the supported slash and opencode memory identity %s', (name, suffix) => {
    expect(matchNotebookMemoryTool(name)).toBe(suffix)
  })

  it.each([
    'bogus.open-science-notebook.remember_memory',
    'proxy/open-science-notebook/remember_memory',
    'mcp__bogus__open-science-notebook__remember_memory',
    'mcp__open-science-notebook.remember_memory',
    'mcp__open-science-notebook__REMEMBER_MEMORY',
    ' mcp__open-science-notebook__remember_memory',
    'mcp__open-science-notebook__remember_memory\t',
    '\nmcp__open-science-notebook__remember_memory\n'
  ])('rejects the unsupported prefixed or mixed memory identity %s', (name) => {
    expect(matchNotebookMemoryTool(name)).toBeUndefined()
  })

  it('rejects empty or missing names', () => {
    expect(isNotebookExecuteToolName('')).toBe(false)
    expect(isNotebookExecuteToolName(undefined)).toBe(false)
    expect(isNotebookExecuteToolName(null)).toBe(false)
  })
})
