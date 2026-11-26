import { describe, expect, it } from 'vitest'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { LiteratureIndex, LiteratureReader } from '@aipoch/literature-reading'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createImageMcpServer } from '../image-model/mcp-server'

import { codexBridgeStaticMcpTools, createCodexBridgeMcpTools } from './codex-bridge-tools'
import {
  LITERATURE_LIBRARY_READ_SCOPES,
  LITERATURE_LIBRARY_SCOPES
} from '../literature/library-mcp-server'

const identity = (tool: { namespace: string; name: string }): string =>
  `${tool.namespace}/${tool.name}`

describe('Codex bridge MCP catalogs', () => {
  it.each([
    'minimax-h3/official',
    'minimax-h3/sglang',
    'openai/gpt-image-2.6',
    'qwen/image-3.0',
    'seedream/5.5',
    'openai-images/generic'
  ])(
    'projects the live image tool schemas for %s only into an enabled session catalog',
    async (presetId) => {
      const server = createImageMcpServer({
        projectId: 'p',
        sessionId: 's',
        currentRunFile: 'unused',
        presetId
      })
      const client = new Client({ name: 'image-catalog-test', version: '1' })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      try {
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
        const live = await client.listTools()
        const projected = createCodexBridgeMcpTools({ images: true, imagePresetId: presetId })
        expect(projected.map(identity).sort()).toEqual(
          live.tools.map(({ name }) => `mcp__open_science_images/${name}`).sort()
        )
        for (const tool of live.tools) {
          const declaration = projected.find(({ name }) => name === tool.name)!
          expect(declaration.description).toBe(tool.description)
          expect({ ...declaration.parameters, $schema: undefined }).toEqual({
            ...tool.inputSchema,
            $schema: undefined
          })
        }
        expect(createCodexBridgeMcpTools({})).toEqual([])
        expect(
          codexBridgeStaticMcpTools().some(
            ({ namespace }) => namespace === 'mcp__open_science_images'
          )
        ).toBe(false)
      } finally {
        await client.close()
        await server.close()
      }
    }
  )

  it.each(['binding-1', 'b'.repeat(512)])(
    'declares a cursor range that accepts a production reader continuation (%#. binding)',
    async (bindingId) => {
      const reader = new LiteratureReader({
        index: new LiteratureIndex({
          exists: async () => false,
          open: async () => {
            throw new Error('Sequential reading must not open the search index')
          }
        }),
        authorize: async () => async () => ({
          text: 'a'.repeat(17_000),
          pageCount: 2,
          truncated: false
        })
      })
      const reference = { bindingId, name: 'paper.pdf', checksum: 'a'.repeat(64), sizeBytes: 10 }
      const first = await reader.readDocument(reference)
      const cursor = first.nextCursor!
      expect(cursor.length).toBeGreaterThan(128)

      for (const tools of [
        codexBridgeStaticMcpTools(),
        createCodexBridgeMcpTools({ literature: true })
      ]) {
        const readDocument = tools.find(
          (entry) => identity(entry) === 'mcp__open_science_literature/read_document'
        )!
        expect(cursor.length).toBeLessThanOrEqual(
          readDocument.parameters.properties.cursor.maxLength
        )
        expect(readDocument.parameters.properties.cursor.maxLength).toBe(2048)
      }
      expect(await reader.readDocument(reference, cursor)).toMatchObject({
        nextCursor: null,
        passage: { text: 'a'.repeat(1000) }
      })
    }
  )

  it('publishes the schedule tools only for enabled sessions', () => {
    const names = (enabled: boolean): string[] =>
      createCodexBridgeMcpTools({ schedules: enabled })
        .filter((t) => t.namespace === 'mcp__open_science_schedule')
        .map((t) => t.name)
        .sort()
    for (const tool of createCodexBridgeMcpTools({ schedules: true }).filter(
      (tool) =>
        tool.namespace === 'mcp__open_science_schedule' &&
        ['create_schedule', 'update_schedule'].includes(tool.name)
    )) {
      expect(JSON.stringify(tool.parameters)).not.toContain('permissionProfile')
      expect(JSON.stringify(tool.parameters)).toContain('Omit for once')
      if (tool.name === 'create_schedule') {
        const validate = new AjvJsonSchemaValidator().getValidator(tool.parameters)
        expect(
          validate({
            turnRef: 'current-turn',
            requestId: 'review',
            name: 'Review',
            rule: { kind: 'daily', time: '09:00' },
            message: 'Review progress.'
          }).valid
        ).toBe(true)
      }
    }
    expect(names(false)).toEqual([])
    expect(names(true)).toEqual([
      'close_schedule',
      'create_schedule',
      'list_schedules',
      'manage_current_schedule',
      'update_schedule'
    ])
  })
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
        'mcp__open_science_literature/read_pdf_element',
        'mcp__open_science_literature/list_pdf_annotations',
        'mcp__open_science_literature/locate_pdf_annotation_target',
        'mcp__open_science_literature/create_pdf_annotation'
      ])
    )
  })

  it('advertises the same Library scopes the MCP server accepts', () => {
    const scopes = (name: string): unknown =>
      codexBridgeStaticMcpTools().find(
        (entry) => identity(entry) === `mcp__open_science_library/${name}`
      )!.parameters.properties.scope.enum
    expect(scopes('search_library')).toEqual([...LITERATURE_LIBRARY_SCOPES])
    expect(scopes('read_library_abstract')).toEqual([...LITERATURE_LIBRARY_READ_SCOPES])
    expect(scopes('read_library_pdf')).toEqual([...LITERATURE_LIBRARY_READ_SCOPES])
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
    expect(names).not.toContain('mcp__open_science_literature/create_pdf_annotation')
  })
})
