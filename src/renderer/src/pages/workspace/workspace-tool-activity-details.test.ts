import { describe, expect, it } from 'vitest'

import type { ToolActivity } from '@/stores/session-store'

import {
  buildToolActivityDetails,
  getSkillLoadDocument,
  getToolDisplayName,
  isEditActivity,
  isSkillActivity,
  parseManagePackagesResult
} from './workspace-tool-activity-details'
import { getLoadedSkillName } from './workspace-skill-load'

const createActivity = (overrides: Partial<ToolActivity>): ToolActivity => ({
  id: 'tool-1',
  kind: 'tool',
  title: '',
  status: 'completed',
  eventIds: [],
  sortIndex: 1,
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

describe('workspace tool activity details', () => {
  it('derives a display name from the provider tool name first', () => {
    expect(
      getToolDisplayName(createActivity({ providerToolName: 'Bash', toolKind: 'execute' }))
    ).toBe('Bash')
    expect(getToolDisplayName(createActivity({ toolKind: 'execute' }))).toBe('Terminal')
    expect(getToolDisplayName(createActivity({ toolKind: undefined }))).toBe('Tool')
  })

  it('keeps native Skill instruction documents out of expandable activity details', () => {
    const activity = createActivity({
      title: 'Loaded skill: mcp-pubmed',
      rawInput: { name: 'mcp-pubmed' },
      toolContent: [
        {
          type: 'content',
          content: { type: 'text', text: '<skill_content>Internal instructions</skill_content>' }
        }
      ]
    })

    expect(isSkillActivity(activity)).toBe(true)
    expect(buildToolActivityDetails(activity)).toBeUndefined()
  })

  it('recognizes an in-progress projected Codex Skill activity and extracts its name', () => {
    const activity = createActivity({
      title: 'Loading skill: mcp-pubmed',
      status: 'in_progress'
    })

    expect(isSkillActivity(activity)).toBe(true)
    expect(getLoadedSkillName(activity)).toBe('mcp-pubmed')
    expect(buildToolActivityDetails(activity)).toBeUndefined()
  })

  it('recognizes the imperative Claude Skill activity title variant', () => {
    const activity = createActivity({
      providerToolName: 'Skill',
      title: 'Load skill: self-awareness'
    })

    expect(isSkillActivity(activity)).toBe(true)
    expect(getLoadedSkillName(activity)).toBe('self-awareness')
    expect(buildToolActivityDetails(activity)).toBeUndefined()
  })

  it('labels a load_skill MCP row with the loaded Skill name and keeps its generic details', () => {
    const activity = createActivity({
      providerToolName: 'mcp__skills__load_skill',
      title: 'mcp__skills__load_skill',
      rawInput: { skill: 'mcp-pubmed' },
      toolContent: [
        {
          type: 'content',
          content: { type: 'text', text: 'Base directory for this skill: /skills/mcp-pubmed' }
        }
      ]
    })

    expect(isSkillActivity(activity)).toBe(true)
    expect(getLoadedSkillName(activity)).toBe('mcp-pubmed')

    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Skill')
    expect(details?.subtitle).toBe('mcp-pubmed')
    expect(details?.sections.map((section) => 'label' in section && section.label)).toEqual([
      'Input',
      'Output'
    ])
  })

  it('projects a Literature search as a semantic card instead of raw MCP JSON', () => {
    const activity = createActivity({
      providerToolName: 'mcp__open-science-literature__read_document',
      title: 'mcp__open-science-literature__read_document',
      rawInput: {
        documentId: 'binding-secret-id',
        query: 'main contributions method architecture evaluation results'
      },
      toolContent: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: JSON.stringify({
              scope: 'relevant-passages',
              retrievalMode: 'bm25',
              documents: [{ id: 'binding-secret-id', name: 'paper.pdf', pageCount: 14 }],
              passages: [
                { documentId: 'binding-secret-id', pageStart: 2, pageEnd: 3, content: 'One' },
                { documentId: 'binding-secret-id', pageStart: 7, pageEnd: 7, content: 'Two' }
              ]
            })
          }
        }
      ]
    })

    const details = buildToolActivityDetails(activity)

    expect(details).toMatchObject({
      displayName: 'Reading',
      subtitle: 'main contributions method architecture evaluation results'
    })
    expect(details?.sections).toEqual([
      {
        kind: 'literature',
        summary: {
          action: 'search',
          query: 'main contributions method architecture evaluation results',
          documentNames: ['paper.pdf'],
          documentCount: 1,
          passageCount: 2,
          pageStart: 2,
          pageEnd: 7,
          retrievalMode: 'bm25'
        }
      }
    ])
    expect(JSON.stringify(details)).not.toContain('binding-secret-id')
  })

  it('keeps a CJK retrieval query out of the Literature presentation', () => {
    const activity = createActivity({
      providerToolName: 'mcp__open-science-literature__read_document',
      rawInput: {
        documentId: 'binding-secret-id',
        query: '梳理这篇论文的核心贡献'
      }
    })

    const details = buildToolActivityDetails(activity)

    expect(details).toMatchObject({
      displayName: 'Reading',
      subtitle: undefined,
      sections: [
        {
          kind: 'literature',
          summary: {
            action: 'search',
            documentCount: 1
          }
        }
      ]
    })
    expect(JSON.stringify(details)).not.toContain('梳理这篇论文的核心贡献')
  })

  it('uses the shared Literature presentation block when OpenCode truncates the full result', () => {
    const activity = createActivity({
      title: 'open_science_literature_read_document',
      rawInput: { query: 'CRAG comparison scores accuracy margin' },
      toolContent: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: JSON.stringify({
              openScienceLiteraturePresentation: {
                retrievalMode: 'bm25',
                documentNames: ['paper.pdf'],
                passageCount: 4,
                pageStart: 4,
                pageEnd: 13
              }
            })
          }
        },
        {
          type: 'content',
          content: {
            type: 'text',
            text: '{"scope":"relevant-passages","retrievalMode":"bm25","passages":[{"content":"truncated…'
          }
        }
      ]
    })

    expect(buildToolActivityDetails(activity)).toMatchObject({
      displayName: 'Reading',
      subtitle: 'CRAG comparison scores accuracy margin',
      sections: [
        {
          kind: 'literature',
          summary: {
            action: 'search',
            query: 'CRAG comparison scores accuracy margin',
            retrievalMode: 'bm25',
            documentNames: ['paper.pdf'],
            documentCount: 1,
            passageCount: 4,
            pageStart: 4,
            pageEnd: 13
          }
        }
      ]
    })
  })

  it('unwraps a native Responses MCP result envelope for the same Literature card', () => {
    const activity = createActivity({
      providerToolName: 'mcp__open-science-literature__read_document',
      rawInput: {
        documentId: 'binding-secret-id',
        query: 'Table main results comparison performance benchmarks datasets'
      },
      rawOutput: {
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                openScienceLiteraturePresentation: {
                  retrievalMode: 'bm25',
                  documentNames: ['paper.pdf'],
                  passageCount: 6,
                  pageStart: 5,
                  pageEnd: 9
                }
              })
            },
            { type: 'text', text: '{"passages":[{"content":"truncated…' }
          ],
          structuredContent: {
            scope: 'relevant-passages',
            retrievalMode: 'bm25',
            documents: [{ id: 'binding-secret-id', name: 'paper.pdf', pageCount: 14 }],
            passages: Array.from({ length: 6 }, (_, index) => ({
              documentId: 'binding-secret-id',
              pageStart: index + 1,
              pageEnd: index + 1,
              content: `Passage ${index + 1}`
            }))
          }
        },
        error: null
      }
    })

    expect(buildToolActivityDetails(activity)?.sections[0]).toMatchObject({
      kind: 'literature',
      summary: {
        action: 'search',
        retrievalMode: 'bm25',
        documentNames: ['paper.pdf'],
        documentCount: 1,
        passageCount: 6,
        pageStart: 5,
        pageEnd: 9
      }
    })
  })

  it('summarizes bounded Literature reads without exposing the cursor', () => {
    const activity = createActivity({
      providerToolName: 'mcp.open-science-literature.read_document',
      rawInput: { documentId: 'binding-id', cursor: 'opaque-cursor' },
      rawOutput: {
        scope: 'full-document',
        document: { id: 'binding-id', name: 'paper.pdf', pageCount: 14 },
        passage: { pageStart: 1, pageEnd: 5, text: 'content' },
        nextCursor: 'next-opaque-cursor'
      }
    })

    const details = buildToolActivityDetails(activity)

    expect(details?.sections[0]).toMatchObject({
      kind: 'literature',
      summary: {
        action: 'read',
        documentNames: ['paper.pdf'],
        documentCount: 1,
        pageStart: 1,
        pageEnd: 5,
        hasMore: true
      }
    })
    expect(JSON.stringify(details)).not.toContain('cursor')
  })

  it('extracts the renderable SKILL.md document from a load_skill output', () => {
    const activity = createActivity({
      providerToolName: 'mcp__skills__load_skill',
      title: 'mcp__skills__load_skill',
      rawInput: { skill: 'mcp-pubmed' },
      toolContent: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: 'Base directory for this skill: /skills/mcp-pubmed\n\n---\nname: mcp-pubmed\ndescription: Search PubMed\n---\n\n# mcp-pubmed\n\nSearch PubMed articles.'
          }
        }
      ]
    })

    expect(getSkillLoadDocument(activity)).toBe('# mcp-pubmed\n\nSearch PubMed articles.')
  })

  it('returns no Skill document when a load_skill output is not a document', () => {
    const activity = createActivity({
      providerToolName: 'mcp__skills__load_skill',
      title: 'mcp__skills__load_skill',
      status: 'failed',
      toolContent: [
        {
          type: 'content',
          content: { type: 'text', text: 'Unknown skill: nope' }
        }
      ]
    })

    expect(getSkillLoadDocument(activity)).toBeUndefined()
  })

  it('reads the Skill name from the Codex arguments envelope on a load_skill row', () => {
    const activity = createActivity({
      providerToolName: 'mcp.skills.load_skill',
      title: 'mcp.skills.load_skill',
      rawInput: { name: 'load_skill', arguments: { skill: 'mcp-pubmed' } }
    })

    expect(isSkillActivity(activity)).toBe(true)
    expect(getLoadedSkillName(activity)).toBe('mcp-pubmed')
  })

  it('does not treat lookalike MCP server or tool names as Skill loads', () => {
    expect(
      isSkillActivity(
        createActivity({ providerToolName: 'mcp__skills__list_skills', rawInput: {} })
      )
    ).toBe(false)
    expect(
      isSkillActivity(
        createActivity({ providerToolName: 'mcp__my-skills__load_skill', rawInput: {} })
      )
    ).toBe(false)
  })

  it('builds command and output code sections for execute tools', () => {
    const activity = createActivity({
      providerToolName: 'Bash',
      toolKind: 'execute',
      title: 'ls -la',
      terminalExitCode: 0,
      toolContent: [
        {
          type: 'content',
          content: { type: 'text', text: '```console\ntotal 8\ndrwxr-xr-x\n```' }
        }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Bash')
    expect(details?.subtitle).toBe('ls -la')
    expect(details?.metaLabel).toBe('exit 0')
    expect(details?.sections).toHaveLength(2)
    expect(details?.sections[0]).toMatchObject({
      kind: 'code',
      label: 'Command',
      language: 'bash',
      text: 'ls -la'
    })
    // The agent wraps stdout in a fenced console block; the parser unwraps it for clean rendering.
    expect(details?.sections[1]).toMatchObject({
      kind: 'code',
      label: 'Output',
      text: 'total 8\ndrwxr-xr-x'
    })
  })

  it('prefers streamed terminal output and raw input for execute tools', () => {
    const activity = createActivity({
      providerToolName: 'Bash',
      toolKind: 'execute',
      title: 'echo hi',
      rawInput: { command: 'echo hi', description: 'greet' },
      terminalOutput: 'hi',
      terminalExitCode: 2
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.metaLabel).toBe('exit 2')
    expect(details?.sections[0]).toMatchObject({ text: 'echo hi', language: 'bash' })
    expect(details?.sections[1]).toMatchObject({ label: 'Output', text: 'hi' })
  })

  it('builds diff sections with add/remove summaries for edit tools', () => {
    const activity = createActivity({
      providerToolName: 'Edit',
      toolKind: 'edit',
      title: 'Edit src/app.ts',
      toolContent: [
        {
          type: 'diff',
          path: '/repo/src/app.ts',
          oldText: 'const a = 1',
          newText: 'const a = 1\nconst b = 2'
        }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Edit')
    expect(details?.subtitle).toBe('/repo/src/app.ts')
    expect(details?.metaLabel).toBe('+2 −1')
    expect(details?.sections[0]).toMatchObject({
      kind: 'diff',
      label: 'app.ts',
      language: 'typescript',
      oldText: 'const a = 1',
      newText: 'const a = 1\nconst b = 2'
    })
  })

  it('summarizes multiple diffs with a file count subtitle', () => {
    const activity = createActivity({
      toolKind: 'edit',
      toolContent: [
        { type: 'diff', path: 'a.ts', oldText: null, newText: 'x' },
        { type: 'diff', path: 'b.ts', oldText: null, newText: 'y' }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.subtitle).toBe('2 files')
    expect(details?.sections).toHaveLength(2)
  })

  it('shows file content for read tools without an input section', () => {
    const activity = createActivity({
      providerToolName: 'Read',
      toolKind: 'read',
      title: 'Read src/util.py',
      toolLocations: [{ path: '/repo/src/util.py' }],
      rawInput: { file_path: '/repo/src/util.py' },
      toolContent: [
        {
          type: 'content',
          content: { type: 'text', text: '```\nprint("hi")\n```' }
        }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.subtitle).toBe('/repo/src/util.py')
    expect(details?.sections).toHaveLength(1)
    expect(details?.sections[0]).toMatchObject({
      kind: 'code',
      label: 'Content',
      language: 'python',
      text: 'print("hi")'
    })
  })

  it('shows input and output sections for generic tools', () => {
    const activity = createActivity({
      providerToolName: 'mcp__db__query',
      toolKind: 'other',
      title: 'Query users',
      rawInput: { table: 'users', limit: 5 },
      toolContent: [{ type: 'content', content: { type: 'text', text: '5 rows returned' } }]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('mcp__db__query')
    expect(details?.sections[0]).toMatchObject({ kind: 'code', label: 'Input', language: 'json' })
    expect(details?.sections[0].kind === 'code' && details.sections[0].text).toContain('"table"')
    expect(details?.sections[1]).toMatchObject({ label: 'Output', text: '5 rows returned' })
  })

  it('renders memory category reads with a friendly name instead of the raw MCP identity', () => {
    const activity = createActivity({
      providerToolName: 'mcp__open-science-notebook__list_memory_categories',
      toolKind: 'other',
      toolContent: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: JSON.stringify([
              {
                id: 'memory-category-about-you',
                name: 'About you',
                guidance: 'Stable facts about the user.',
                autoRecall: true,
                entryCount: 2
              }
            ])
          }
        }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Memory categories')
    expect(details?.displayName).not.toContain('mcp__')
    expect(details?.sections[0]).toMatchObject({ label: 'Output' })
  })

  it('summarizes memory searches by query across the Codex MCP envelope', () => {
    const activity = createActivity({
      title: 'mcp.open-science-notebook.search_memories',
      toolKind: 'execute',
      rawInput: {
        server: 'open-science-notebook',
        tool: 'search_memories',
        arguments: { query: 'microscopy preferences', limit: 5 }
      },
      rawOutput: []
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Search memory')
    expect(details?.subtitle).toBe('microscopy preferences')
  })

  it('summarizes saved memory by the category returned through an MCP result envelope', () => {
    const activity = createActivity({
      title: 'mcp.open-science-notebook.remember_memory',
      toolKind: 'other',
      rawInput: {
        server: 'open-science-notebook',
        tool: 'remember_memory',
        arguments: {
          categoryId: 'memory-category-about-you',
          content: 'Prefers concise status updates.'
        }
      },
      rawOutput: {
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'created',
                memory: {
                  id: 'memory-entry-1',
                  categoryId: 'memory-category-about-you',
                  categoryName: 'About you',
                  scope: 'project',
                  content: 'Prefers concise status updates.',
                  revision: 1,
                  provenance: { origin: 'agent' },
                  updatedAt: 1710000000000
                }
              })
            }
          ]
        }
      }
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Save memory')
    expect(details?.subtitle).toBe('About you')
    expect(details?.sections).toHaveLength(2)
  })

  it.each([
    { content: JSON.stringify({ categoryName: 'Private payload label' }) },
    {
      result: { content: [{ type: 'text', text: JSON.stringify({ categoryName: 'Incomplete' }) }] }
    }
  ])('does not summarize an invalid saved-memory receipt', (rawOutput) => {
    const activity = createActivity({
      providerToolName: 'mcp__open-science-notebook__remember_memory',
      toolKind: 'other',
      rawInput: {
        categoryId: 'memory-category-about-you',
        content: 'Prefers concise status updates.'
      },
      rawOutput
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Save memory')
    expect(details?.subtitle).toBeUndefined()
    expect(details?.sections).toHaveLength(2)
  })

  it.each([
    'proxy/open-science-notebook/remember_memory',
    'mcp__open-science-notebook__REMEMBER_MEMORY'
  ])('keeps the generic fallback for the unsupported memory identity %s', (providerToolName) => {
    const activity = createActivity({
      providerToolName,
      toolKind: 'other',
      rawOutput: {
        id: 'memory-entry-1',
        categoryId: 'memory-category-about-you',
        categoryName: 'About you',
        content: 'Prefers concise status updates.',
        revision: 1,
        provenance: { origin: 'agent' },
        updatedAt: 1710000000000
      }
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe(providerToolName)
    expect(details?.subtitle).toBeUndefined()
    expect(details?.sections).toHaveLength(1)
  })

  it('renders a notebook cell as Python code plus output, not the raw run summary', () => {
    const runSummary = {
      runId: 'notebook-run-1',
      status: 'completed',
      script: 'import numpy as np\nprint(np.sin(0))',
      text: { stdout: '0.0\n', stderr: '', traceback: '', plain: ['0.0'] },
      outputs: []
    }
    const activity = createActivity({
      providerToolName: 'mcp__open-science-notebook__notebook_execute',
      toolKind: 'other',
      rawInput: { code: 'import numpy as np\nprint(np.sin(0))' },
      toolContent: [
        { type: 'content', content: { type: 'text', text: JSON.stringify(runSummary) } }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Notebook run')
    // Only the compact run id enters transcript presentation data. Figure bytes stay in the local
    // notebook state and are resolved by the expanded row at render time.
    expect(details?.notebookRunId).toBe('notebook-run-1')
    expect(details?.sections[0]).toMatchObject({
      kind: 'code',
      label: 'Code',
      language: 'python',
      text: 'import numpy as np\nprint(np.sin(0))'
    })
    expect(details?.sections[1]).toMatchObject({
      label: 'Output',
      text: '0.0',
      collapsible: true
    })
    // The code section stays open; only the output collapses.
    expect(details?.sections[0]).toMatchObject({ label: 'Code' })
    expect((details?.sections[0] as { collapsible?: boolean }).collapsible).toBeFalsy()
  })

  it('renders a Codex notebook activity from its dotted title and MCP arguments envelope', () => {
    const runSummary = {
      status: 'completed',
      text: { stdout: '42\n', stderr: '', traceback: '' },
      outputs: []
    }
    const activity = createActivity({
      title: 'mcp.open-science-notebook.notebook_execute',
      toolKind: 'execute',
      rawInput: {
        server: 'open-science-notebook',
        tool: 'notebook_execute',
        arguments: { kernelKind: 'python', code: 'print(42)' }
      },
      toolContent: [
        { type: 'content', content: { type: 'text', text: JSON.stringify(runSummary) } }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Notebook run')
    expect(details?.sections[0]).toMatchObject({
      kind: 'code',
      label: 'Code',
      language: 'python',
      text: 'print(42)'
    })
    expect(details?.sections[1]).toMatchObject({ kind: 'code', label: 'Output', text: '42' })
  })

  it('renders an opencode single-underscore notebook tool as code, not raw JSON', () => {
    // opencode names the tool <server>_<tool> (no mcp__ prefix); the activity must still render as
    // a notebook cell rather than falling back to the run-summary envelope.
    const activity = createActivity({
      providerToolName: 'open-science-notebook_notebook_execute',
      toolKind: 'execute',
      rawInput: { code: 'print(1)' },
      toolContent: []
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Notebook run')
    expect(details?.sections[0]).toMatchObject({
      kind: 'code',
      language: 'python',
      text: 'print(1)'
    })
  })

  it('labels a notebook cell with its clean kernel name, never the raw tool id', () => {
    const runSummary = {
      status: 'completed',
      script: 'x = 1',
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: []
    }
    const activity = createActivity({
      // The runtime may backfill an untitled call with the raw tool id; the row label ignores it.
      title: 'mcp__open-science-notebook__notebook_execute',
      providerToolName: 'mcp__open-science-notebook__notebook_execute',
      rawInput: { code: 'x = 1' },
      toolContent: [
        { type: 'content', content: { type: 'text', text: JSON.stringify(runSummary) } }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Notebook run')
  })

  it('falls back to the run summary script when notebook input code is unavailable', () => {
    const runSummary = {
      status: 'failed',
      script: "raise ValueError('boom')",
      text: { stdout: '', stderr: 'ValueError: boom', traceback: 'Traceback...\nValueError: boom' }
    }
    const activity = createActivity({
      providerToolName: 'mcp__open-science-notebook__notebook_execute',
      toolKind: 'other',
      toolContent: [
        { type: 'content', content: { type: 'text', text: JSON.stringify(runSummary) } }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.metaLabel).toBe('failed')
    expect(details?.sections[0]).toMatchObject({
      label: 'Code',
      language: 'python',
      text: "raise ValueError('boom')"
    })
    expect(details?.sections[1]?.kind === 'code' && details.sections[1].text).toContain(
      'ValueError: boom'
    )
  })

  it('uses the run summary kernel when notebook raw input is unavailable', () => {
    const runSummary = {
      status: 'completed',
      kernelKind: 'r',
      // Deliberately ambiguous: the code heuristic defaults this to Python without summary metadata.
      script: 'print("from R")',
      text: { stdout: '[1] "from R"\n', stderr: '', traceback: '', plain: [] }
    }
    const activity = createActivity({
      providerToolName: 'mcp__open-science-notebook__notebook_execute',
      toolKind: 'other',
      toolContent: [
        { type: 'content', content: { type: 'text', text: JSON.stringify(runSummary) } }
      ]
    })

    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Notebook run')
    expect(details?.sections[0]).toMatchObject({
      label: 'Code',
      language: 'r',
      text: 'print("from R")'
    })
  })

  it('renders a repl_execute run as Agent SDK JavaScript code plus its echoed result', () => {
    const runSummary = {
      status: 'completed',
      kernelKind: 'repl',
      stdout: '',
      stderr: '',
      traceback: '',
      outputs: [{ type: 'display', data: { 'text/plain': '{ pmids: [ "1", "2" ] }' } }]
    }
    const activity = createActivity({
      providerToolName: 'mcp__open-science-notebook__repl_execute',
      toolKind: 'other',
      rawInput: { code: 'const r = await host.mcp.pubmed.search({}); r' },
      toolContent: [
        { type: 'content', content: { type: 'text', text: JSON.stringify(runSummary) } }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Agent SDK')
    expect(details?.sections[0]).toMatchObject({
      kind: 'code',
      label: 'Code',
      language: 'javascript',
      text: 'const r = await host.mcp.pubmed.search({}); r'
    })
    // The echoed value lives in a display output (not stdout); it must still surface as the result.
    expect(details?.sections[1]).toMatchObject({ label: 'Output', collapsible: true })
    expect(details?.sections[1]?.kind === 'code' && details.sections[1].text).toContain('pmids')
  })

  it('reads top-level stdout for a repl_execute control-plane result', () => {
    const runSummary = {
      status: 'completed',
      kernelKind: 'repl',
      stdout: '{\n  "pmids": ["1"]\n}\n',
      outputs: []
    }
    const activity = createActivity({
      providerToolName: 'mcp__open-science-notebook__repl_execute',
      toolKind: 'other',
      rawInput: { code: 'console.log(JSON.stringify(x))' },
      toolContent: [
        { type: 'content', content: { type: 'text', text: JSON.stringify(runSummary) } }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.sections[1]?.kind === 'code' && details.sections[1].text).toContain('"pmids"')
  })

  it('renders a bash_execute run as a Shell command plus output', () => {
    const runSummary = {
      status: 'completed',
      kernelKind: 'bash',
      stdout: 'file.txt\n',
      stderr: '',
      exitCode: 0,
      outputs: []
    }
    const activity = createActivity({
      providerToolName: 'mcp__open-science-notebook__bash_execute',
      toolKind: 'other',
      rawInput: { command: 'ls' },
      toolContent: [
        { type: 'content', content: { type: 'text', text: JSON.stringify(runSummary) } }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Shell')
    expect(details?.sections[0]).toMatchObject({ label: 'Command', language: 'bash', text: 'ls' })
    expect(details?.sections[1]?.kind === 'code' && details.sections[1].text).toContain('file.txt')
  })

  it('summarizes a manage_packages install with method and a cleaned log, not raw JSON', () => {
    const result = {
      ok: true,
      needsRestart: false,
      method: 'cran',
      log: 'trying URL ...\n\n\n\ndownloaded 1.1 MB\n'
    }
    const activity = createActivity({
      providerToolName: 'mcp__open-science-notebook__manage_packages',
      toolKind: 'other',
      rawInput: { language: 'r', packages: ['jsonlite'] },
      toolContent: [{ type: 'content', content: { type: 'text', text: JSON.stringify(result) } }]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Manage packages')
    expect(details?.subtitle).toBe('jsonlite')
    expect(details?.metaLabel).toBe('cran')

    const logSection = details?.sections.find(
      (section) => section.kind === 'code' && section.label === 'Log'
    )

    expect(logSection?.kind === 'code' && logSection.collapsible).toBe(true)
    // The raw { ok, method, ... } envelope must not be dumped; the cleaned install log shows instead.
    expect(logSection?.kind === 'code' && logSection.text).not.toContain('"ok"')
    expect(logSection?.kind === 'code' && logSection.text).toContain('downloaded 1.1 MB')
  })

  it('shows the manage_packages command and install location, not just the log', () => {
    const result = {
      ok: true,
      needsRestart: false,
      method: 'conda',
      prefix: '/Users/x/OpenScience/runtime/envs/analysis',
      log: 'done'
    }
    const activity = createActivity({
      providerToolName: 'mcp__open-science-notebook__manage_packages',
      toolKind: 'other',
      rawInput: { language: 'python', packages: ['numpy', 'pandas'], environment: 'analysis' },
      toolContent: [{ type: 'content', content: { type: 'text', text: JSON.stringify(result) } }]
    })
    const details = buildToolActivityDetails(activity)

    const commandSection = details?.sections.find(
      (section) => section.kind === 'code' && section.label === 'Command'
    )
    expect(commandSection?.kind === 'code' && commandSection.text).toContain(
      'manage_packages(language="python", packages=["numpy", "pandas"], environment="analysis")'
    )
    // The concrete env-scoped install location is surfaced (the "where is it installed" ask).
    expect(commandSection?.kind === 'code' && commandSection.text).toContain(
      'installs into  /Users/x/OpenScience/runtime/envs/analysis'
    )
  })

  it('flags a manage_packages result that needs a restart', () => {
    const result = { ok: true, needsRestart: true, method: 'conda', log: 'done' }
    const activity = createActivity({
      providerToolName: 'mcp__open-science-notebook__manage_packages',
      toolKind: 'other',
      rawInput: { language: 'python', packages: ['numpy', 'pandas'] },
      toolContent: [{ type: 'content', content: { type: 'text', text: JSON.stringify(result) } }]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.subtitle).toBe('numpy, pandas')
    expect(details?.metaLabel).toBe('conda · restart needed')
  })

  it('shows the discarded byte count when a manage_packages log was truncated', () => {
    const result = {
      ok: true,
      needsRestart: false,
      method: 'pip',
      logTruncation: { droppedBytes: 1536 }
    }
    const activity = createActivity({
      providerToolName: 'mcp__open-science-notebook__manage_packages',
      toolKind: 'other',
      rawInput: { language: 'python', packages: ['numpy'] },
      toolContent: [{ type: 'content', content: { type: 'text', text: JSON.stringify(result) } }]
    })

    expect(buildToolActivityDetails(activity)?.metaLabel).toBe('pip · log truncated (2 KB dropped)')
  })

  it('shows verified requested-package version changes from manage_packages', () => {
    const activity = createActivity({
      providerToolName: 'mcp__open-science-notebook__manage_packages',
      toolKind: 'other',
      rawInput: { language: 'python', packages: ['numpy', 'pandas'] },
      toolContent: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              needsRestart: false,
              method: 'conda',
              packageChanges: [
                {
                  name: 'numpy',
                  change: 'updated',
                  beforeVersion: '2.1.0',
                  afterVersion: '2.2.0'
                },
                {
                  name: 'pandas',
                  change: 'unchanged',
                  beforeVersion: '2.2.3',
                  afterVersion: '2.2.3'
                }
              ]
            })
          }
        }
      ]
    })

    const details = buildToolActivityDetails(activity)
    const packagesSection = details?.sections.find(
      (section) => section.kind === 'code' && section.label === 'Packages'
    )

    expect(packagesSection?.kind === 'code' && packagesSection.text).toContain(
      'numpy: 2.1.0 → 2.2.0'
    )
    expect(packagesSection?.kind === 'code' && packagesSection.text).toContain(
      'pandas: unchanged at 2.2.3'
    )
  })

  it('unwraps verified package versions from ACP structured output', () => {
    const packageChanges = [
      {
        name: 'numpy',
        change: 'unchanged',
        beforeVersion: '2.5.1',
        afterVersion: '2.5.1'
      }
    ]
    const activity = createActivity({
      providerToolName: 'mcp__open-science-notebook__manage_packages',
      rawOutput: {
        structuredContent: {
          ok: true,
          needsRestart: false,
          method: 'conda',
          environmentName: 'analysis',
          packageChanges
        }
      }
    })

    expect(parseManagePackagesResult(activity)).toMatchObject({
      method: 'conda',
      environmentName: 'analysis',
      packageChanges
    })
  })

  it('unwraps verified package versions from raw MCP text content', () => {
    const packageChanges = [
      {
        name: 'pandas',
        change: 'installed',
        afterVersion: '3.0.3'
      }
    ]
    const activity = createActivity({
      providerToolName: 'mcp__open-science-notebook__manage_packages',
      rawOutput: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              needsRestart: false,
              method: 'conda',
              packageChanges
            })
          }
        ]
      }
    })

    expect(parseManagePackagesResult(activity)).toMatchObject({ method: 'conda', packageChanges })
  })

  it('summarizes a path-only image artifact without reading its bytes', () => {
    const activity = createActivity({
      providerToolName: 'write_artifact_file',
      toolKind: 'other',
      title: 'Write artifact file',
      rawInput: {
        filename: 'report.png',
        mimeType: 'image/png',
        content: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWY=',
        encoding: 'base64'
      },
      toolContent: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: JSON.stringify({
              artifact: {
                name: 'report.png',
                path: '/files/report.png',
                mimeType: 'image/png',
                size: 2048
              }
            })
          }
        }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Write file')
    expect(details?.subtitle).toBe('report.png')
    expect(details?.metaLabel).toBe('2 KB')
    expect(details?.sections).toHaveLength(1)

    const section = details?.sections[0]

    expect(section).toMatchObject({
      kind: 'code',
      label: 'Tool output image',
      language: 'json'
    })
    if (section?.kind !== 'code') throw new Error('Expected an artifact summary.')
    expect(JSON.parse(section.text)).toEqual({
      file: 'report.png',
      type: 'image/png',
      size: '2 KB',
      path: '/files/report.png'
    })
  })

  it('summarizes a non-image artifact-write MCP tool without echoing file content', () => {
    const activity = createActivity({
      providerToolName: 'write_artifact_file',
      toolKind: 'other',
      title: 'Write artifact file',
      rawInput: {
        filename: 'report.csv',
        mimeType: 'text/csv',
        content: 'a,b\n1,2',
        encoding: 'utf8'
      },
      toolContent: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: JSON.stringify({
              artifact: {
                name: 'report.csv',
                path: '/files/report.csv',
                mimeType: 'text/csv',
                size: 2048
              }
            })
          }
        }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Write file')
    expect(details?.subtitle).toBe('report.csv')
    expect(details?.metaLabel).toBe('2 KB')
    expect(details?.sections).toHaveLength(1)

    const section = details?.sections[0]

    expect(section?.kind).toBe('code')
    expect(section?.kind === 'code' && section.text).toContain('report.csv')
    expect(section?.kind === 'code' && section.text).toContain('/files/report.csv')
    // The raw file content must never be dumped into the transcript.
    expect(section?.kind === 'code' && section.text).not.toContain('a,b')
  })

  it('matches the artifact-write tool by name even when MCP-namespaced', () => {
    const activity = createActivity({
      providerToolName: 'mcp__open-science-artifacts__write_artifact_file',
      toolKind: 'other',
      rawInput: { filename: 'data.csv', content: 'a,b\n1,2', encoding: 'utf8' }
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Write file')
    expect(details?.subtitle).toBe('data.csv')
    expect(details?.sections[0]?.kind === 'code' && details.sections[0].text).not.toContain('a,b')
  })

  it('does not classify artifact-file lookalikes as managed writes', () => {
    const activity = createActivity({
      providerToolName: 'delete_artifact_file',
      toolKind: 'other',
      title: 'Delete artifact file',
      rawInput: { filename: 'obsolete.csv' },
      rawOutput: { deleted: true }
    })

    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('delete_artifact_file')
    expect(details?.sections.map((section) => 'label' in section && section.label)).toEqual([
      'Input',
      'Output'
    ])
    expect(details?.sections[1]?.kind === 'code' && details.sections[1].text).toContain('deleted')
  })

  it('summarizes a Codex artifact receipt envelope when the MCP identity is only in the title', () => {
    const artifactReceipt = {
      artifact: {
        artifact_id: 'bfa741b1-2088-42b0-b075-812a640e1ec6',
        version_id: 'de3cfa20-2cea-4f8a-87cd-7b482410e0ed',
        version_number: 1,
        filename: 'sin.png',
        content_type: 'image/png',
        size_bytes: 41671,
        checksum: '75e5991b3bac5025d01ae83eb0d85fab922153411edb8d19859f728528f20a68',
        producer_run_id: 'notebook-run-1785397616378-1',
        environment: 'default-python'
      }
    }
    const activity = createActivity({
      toolKind: 'execute',
      title: 'mcp.open-science-artifacts.write_artifact_file',
      rawOutput: {
        result: {
          content: [{ type: 'text', text: JSON.stringify(artifactReceipt) }],
          structuredContent: null,
          _meta: null
        },
        error: null
      }
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Write file')
    expect(details?.subtitle).toBe('sin.png')
    expect(details?.metaLabel).toBe('41 KB')
    expect(details?.sections.map((section) => 'label' in section && section.label)).toEqual([
      'Tool output image'
    ])
    expect(details?.sections[0]?.kind === 'code' && details.sections[0].text).toContain('sin.png')
    expect(details?.sections[0]?.kind === 'code' && details.sections[0].text).not.toContain(
      'artifact_id'
    )
    expect(details?.sections[0]?.kind === 'code' && details.sections[0].text).not.toContain(
      'structuredContent'
    )
  })

  it('renders a WebFetch with its URL, prompt, and fetched result', () => {
    const activity = createActivity({
      providerToolName: 'WebFetch',
      toolKind: 'fetch',
      title: 'Fetch https://anthropic.com/news',
      rawInput: { url: 'https://anthropic.com/news', prompt: 'Extract the feature list' },
      toolContent: [
        { type: 'content', content: { type: 'text', text: 'Feature A, Feature B, pricing' } }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Web Fetch')
    expect(details?.subtitle).toBe('https://anthropic.com/news')
    expect(details?.sections.map((section) => 'label' in section && section.label)).toEqual([
      'Prompt',
      'Result'
    ])
    expect(details?.sections[1]?.kind === 'code' && details.sections[1].text).toContain('Feature A')
  })

  it('derives the WebFetch URL from a "Fetch <url>" title when raw input is absent', () => {
    const activity = createActivity({
      providerToolName: 'WebFetch',
      toolKind: 'fetch',
      title: 'Fetch https://example.com/page'
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Web Fetch')
    expect(details?.subtitle).toBe('https://example.com/page')
  })

  it('keeps a WebFetch without a trusted URL as a plain chip', () => {
    const activity = createActivity({
      providerToolName: 'WebFetch',
      toolKind: 'fetch',
      title: '"https://example.com/resource"'
    })

    expect(buildToolActivityDetails(activity)).toBeUndefined()
  })

  it('summarizes a ToolSearch by the tools it discovered', () => {
    const activity = createActivity({
      providerToolName: 'ToolSearch',
      title: 'ToolSearch',
      toolContent: [
        {
          type: 'content',
          content: { type: 'text', text: 'Tools found: WebSearch, WebFetch, CronCreate' }
        }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Tool search')
    expect(details?.subtitle).toBe('WebSearch, WebFetch, CronCreate')
    expect(details?.sections[0]?.kind === 'code' && details.sections[0].text).toContain('WebSearch')
  })

  it('keeps a ToolSearch wrapper without results as a plain chip', () => {
    const activity = createActivity({ providerToolName: 'ToolSearch', title: 'ToolSearch' })

    expect(buildToolActivityDetails(activity)).toBeUndefined()
  })

  it('treats a named editor tool as an edit even without the ACP edit kind', () => {
    const activity = createActivity({
      providerToolName: 'Edit',
      toolKind: 'other',
      title: 'Edit',
      toolLocations: [{ path: '/tmp/kiro_tool_test.txt' }],
      rawInput: { path: '/tmp/kiro_tool_test.txt', old_str: 'a', new_str: 'b' }
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Edit')
    expect(details?.subtitle).toBe('/tmp/kiro_tool_test.txt')
    expect(isEditActivity(activity)).toBe(true)
  })

  it('drops a generic subtitle that merely repeats the tool name', () => {
    const activity = createActivity({
      providerToolName: 'Monitor',
      toolKind: 'other',
      title: 'Monitor',
      rawInput: { target: 'cpu' }
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Monitor')
    // "Monitor · Monitor" collapses to just the tool name.
    expect(details?.subtitle).toBeUndefined()
  })

  it('keeps web fetch activities as plain chips without detail sections', () => {
    const activity = createActivity({
      providerToolName: 'WebFetch',
      toolKind: 'fetch',
      title: '"https://example.com"',
      toolContent: [
        { type: 'content', content: { type: 'text', text: '[Link](https://example.com/x)' } }
      ]
    })

    expect(buildToolActivityDetails(activity)).toBeUndefined()
  })

  it('returns nothing when a tool has no command, diff, or output to show', () => {
    expect(buildToolActivityDetails(createActivity({ toolKind: 'read' }))).toBeUndefined()
    expect(buildToolActivityDetails(createActivity({ toolKind: 'other' }))).toBeUndefined()
  })

  it('truncates oversized output and flags the truncation', () => {
    const activity = createActivity({
      toolKind: 'other',
      terminalOutput: undefined,
      toolContent: [{ type: 'content', content: { type: 'text', text: 'a'.repeat(25000) } }]
    })
    const details = buildToolActivityDetails(activity)
    const section = details?.sections[0]

    expect(section?.kind).toBe('code')
    expect(section?.kind === 'code' && section.truncated).toBe(true)
    expect(section?.kind === 'code' && section.text.length).toBeLessThan(25000)
  })
})
