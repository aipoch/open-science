import { describe, expect, it } from 'vitest'

import { codexBridgeStaticMcpTools, createCodexBridgeMcpTools } from './codex-bridge-tools'

const identity = (tool: { namespace: string; name: string }): string =>
  `${tool.namespace}/${tool.name}`

describe('Codex bridge MCP catalogs', () => {
  it('declares every static Literature and Library tool', () => {
    const names = new Set(codexBridgeStaticMcpTools().map(identity))
    expect([...names]).toEqual(
      expect.arrayContaining([
        'mcp__open_science_library/search_library',
        'mcp__open_science_library/read_library_abstract',
        'mcp__open_science_library/read_library_pdf',
        'mcp__open_science_library/format_references',
        'mcp__open_science_library/format_citation_document',
        'mcp__open_science_library/prepare_latex_bundle',
        'mcp__open_science_library/save_to_inbox',
        'mcp__open_science_library/acquire_pdf',
        'mcp__open_science_literature/read_document',
        'mcp__open_science_literature/list_pdf_elements',
        'mcp__open_science_literature/read_pdf_element'
      ])
    )
  })

  it('projects Notebook memory, shell, and WSL setup capabilities', () => {
    const names = new Set(
      createCodexBridgeMcpTools({
        notebook: { memoryTools: true, wslSetupTools: true },
        artifacts: false,
        library: false,
        literature: false
      }).map(identity)
    )
    expect(names).toContain('mcp__open_science_notebook/list_memory_categories')
    expect(names).toContain('mcp__open_science_notebook/wsl_setup_open_terminal')
    expect(names).toContain('mcp__open_science_notebook/bash_execute')
  })

  it('omits optional Literature and Library tools without their handlers', () => {
    const names = new Set(
      createCodexBridgeMcpTools({
        library: {
          formatReferences: false,
          formatCitationDocument: false,
          prepareLatexBundle: false,
          acquirePdf: false
        },
        literature: { elements: false }
      }).map(identity)
    )
    expect(names).toContain('mcp__open_science_library/search_library')
    expect(names).toContain('mcp__open_science_library/save_to_inbox')
    expect(names).not.toContain('mcp__open_science_library/format_references')
    expect(names).not.toContain('mcp__open_science_library/format_citation_document')
    expect(names).not.toContain('mcp__open_science_library/prepare_latex_bundle')
    expect(names).not.toContain('mcp__open_science_library/acquire_pdf')
    expect(names).toContain('mcp__open_science_literature/read_document')
    expect(names).not.toContain('mcp__open_science_literature/list_pdf_elements')
    expect(names).not.toContain('mcp__open_science_literature/read_pdf_element')
  })
})
