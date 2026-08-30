import type { AcpPermissionRequest } from '../../../../shared/acp'
import { describe, expect, it } from 'vitest'

import { describePermissionRequest } from './permission-request-presentation'

const request = (overrides: Partial<AcpPermissionRequest>): AcpPermissionRequest => ({
  requestId: 'request-1',
  sessionId: 'session-1',
  toolCallId: 'tool-1',
  title: 'Tool request',
  options: [],
  ...overrides
})

describe('describePermissionRequest', () => {
  it('renders the app-owned Specialist switch approval on the standard permission card', () => {
    expect(
      describePermissionRequest(
        request({
          title: 'Switch to Data Analyst?',
          providerToolName: 'Open Science',
          rawInput: {
            specialistApproval: { kind: 'switch', targetName: 'Data Analyst' }
          }
        })
      )
    ).toMatchObject({
      actionTitle: 'Switch to Data Analyst?',
      categoryLabel: 'Specialist handoff',
      hideToolIdentity: true
    })
  })

  it.each([
    ['python', 'notebook_execute', { kernelKind: 'python', code: 'print(1)' }, 'Python execution'],
    ['r', 'notebook_execute', { code: 'library(ggplot2)' }, 'R execution'],
    ['js', 'repl_execute', { code: 'const value = 1' }, 'JS REPL'],
    ['bash', 'bash_execute', { command: 'pwd' }, 'Notebook shell']
  ] as const)(
    'classifies notebook %s execution independently',
    (runtime, tool, rawInput, categoryLabel) => {
      const presentation = describePermissionRequest(
        request({
          title: `mcp__open-science-notebook__${tool}`,
          providerToolName: `mcp__open-science-notebook__${tool}`,
          isMcp: true,
          mcpIdentity: `open-science-notebook/${tool}`,
          rawInput
        })
      )

      expect(presentation).toMatchObject({ notebookRuntime: runtime, categoryLabel })
    }
  )

  it('explains a notebook restart without exposing its protocol identifier', () => {
    expect(
      describePermissionRequest(
        request({
          title: 'mcp__open-science-notebook__notebook_restart',
          providerToolName: 'mcp__open-science-notebook__notebook_restart',
          isMcp: true,
          mcpIdentity: 'open-science-notebook/notebook_restart'
        })
      )
    ).toMatchObject({
      actionTitle: 'Restart notebook?',
      categoryLabel: 'Notebook control',
      description:
        'Restarts the current notebook environment. Running processes and unsaved runtime state may be lost.',
      hideToolIdentity: true
    })
  })

  it('describes listing notebook runtimes as a read-only action', () => {
    expect(
      describePermissionRequest(
        request({
          title: 'mcp__open-science-notebook__list_notebook_runtimes',
          isMcp: true,
          mcpIdentity: 'open-science-notebook/list_notebook_runtimes'
        })
      )
    ).toMatchObject({
      actionTitle: 'View notebook runtimes?',
      description: 'Lists the notebook runtimes available to this conversation.'
    })
  })

  it('describes package inspection as read-only and separately from package management', () => {
    expect(
      describePermissionRequest(
        request({
          title: 'mcp__open-science-notebook__inspect_packages',
          isMcp: true,
          mcpIdentity: 'open-science-notebook/inspect_packages'
        })
      )
    ).toMatchObject({
      actionTitle: 'View notebook packages?',
      categoryLabel: 'Notebook control',
      description:
        'Reads installed package names and versions from the bound app-managed runtime without changing it.'
    })
  })

  it.each([
    [request({ toolKind: 'read' }), 'File access'],
    [request({ toolKind: 'fetch' }), 'Network access'],
    [request({ providerToolName: 'Bash', toolKind: 'execute' }), 'Command execution'],
    [request({ isMcp: true }), 'External service']
  ])('classifies current non-notebook permission types', (permission, categoryLabel) => {
    expect(describePermissionRequest(permission).categoryLabel).toBe(categoryLabel)
  })

  it('humanizes an otherwise-opaque MCP action without keeping its protocol spelling', () => {
    expect(
      describePermissionRequest(
        request({
          title: 'mcp__research-service__search_papers',
          isMcp: true,
          mcpIdentity: 'research-service/search_papers'
        })
      ).actionDetail
    ).toBe('Research Service / Search Papers')
  })

  it('classifies the managed artifact writer as an artifact save', () => {
    expect(
      describePermissionRequest(
        request({
          title: 'mcp__open-science-artifacts__write_artifact_file',
          isMcp: true,
          mcpIdentity: 'open-science-artifacts/write_artifact_file'
        })
      )
    ).toMatchObject({
      actionTitle: 'Save as artifact?',
      categoryLabel: 'Artifact save'
    })
  })

  it('describes a Literature search without exposing its MCP identity', () => {
    expect(
      describePermissionRequest(
        request({
          title: 'mcp__open-science-literature__read_document',
          providerToolName: 'mcp__open-science-literature__read_document',
          isMcp: true,
          mcpIdentity: 'open-science-literature/read_document',
          rawInput: { documentId: 'binding-id', query: 'core contributions and evaluation' }
        })
      )
    ).toMatchObject({
      actionTitle: 'Search linked PDFs?',
      categoryLabel: 'Reading',
      hideToolIdentity: true
    })
  })

  it('describes a bounded Literature read separately from search', () => {
    expect(
      describePermissionRequest(
        request({
          isMcp: true,
          mcpIdentity: 'open-science-literature/read_document',
          rawInput: { documentId: 'binding-id' }
        })
      )
    ).toMatchObject({ actionTitle: 'Read linked PDF?', categoryLabel: 'Reading' })
  })

  it('distinguishes permission to create and decide Plans from approval of a specific Plan', () => {
    expect(
      describePermissionRequest(
        request({
          title: 'mcp__open-science-plan__generate_plan',
          isMcp: true,
          mcpIdentity: 'open-science-plan/generate_plan'
        })
      )
    ).toMatchObject({
      actionTitle: 'Allow Plan creation and recording your decisions?',
      categoryLabel: 'Plan control',
      description:
        'Creates Plans and records decisions you make during review. This Permission Grant never approves a Plan; you must approve each Plan separately.',
      hideToolIdentity: true
    })
  })

  it('distinguishes permission to update approved Plan progress from Plan approval', () => {
    expect(
      describePermissionRequest(
        request({
          title: 'mcp__open-science-plan__update_step_status',
          isMcp: true,
          mcpIdentity: 'open-science-plan/update_step_status'
        })
      )
    ).toMatchObject({
      actionTitle: 'Allow updates to approved Plan progress?',
      categoryLabel: 'Plan control',
      description: 'Updates progress for an approved Plan. This does not approve Plans.',
      hideToolIdentity: true
    })
  })

  it('does not classify an artifact-looking provider title without the broker identity', () => {
    expect(
      describePermissionRequest(
        request({
          title: 'mcp__open-science-artifacts__write_artifact_file',
          isMcp: true
        })
      ).categoryLabel
    ).toBe('External service')
  })

  it('keeps an unresolved MCP request distinguishable without granting it a special category', () => {
    expect(
      describePermissionRequest(request({ title: 'open-science-notebook', isMcp: true }))
    ).toMatchObject({
      actionTitle: 'Use Open Science Notebook?',
      categoryLabel: 'External service',
      actionDetail: 'Open Science Notebook'
    })
  })

  it('does not infer MCP origin from a raw protocol name in the renderer', () => {
    expect(
      describePermissionRequest(
        request({
          title: 'mcp__runner__execute',
          isMcp: false,
          toolKind: 'execute'
        })
      )
    ).toMatchObject({
      actionTitle: 'Run command?',
      categoryLabel: 'Command execution'
    })
  })

  it('uses the broker-projected MCP identity when an MCP title is generic', () => {
    expect(
      describePermissionRequest(
        request({
          title: 'Run MCP tool',
          providerToolName: 'mcp__reviewer__review_document',
          isMcp: true,
          mcpIdentity: 'reviewer/review_document'
        })
      ).actionDetail
    ).toBe('Reviewer / Review Document')
  })

  it('keeps the stable MCP identity when a provider title is human-readable', () => {
    expect(
      describePermissionRequest(
        request({
          title: 'Write report.md',
          isMcp: true,
          mcpIdentity: 'research-service/write_report'
        })
      ).actionDetail
    ).toBe('Research Service / Write Report')
  })

  it('does not give a sanitized notebook-looking non-MCP name notebook privileges', () => {
    expect(
      describePermissionRequest(
        request({ title: 'open_science_notebook_notebook_restart', isMcp: false })
      ).categoryLabel
    ).toBe('Tool access')
  })

  it('uses a trusted canonical identity for Codex notebook execution', () => {
    expect(
      describePermissionRequest(
        request({
          title: 'execute',
          isMcp: true,
          mcpIdentity: 'open-science-notebook/notebook_execute',
          rawInput: { language: 'r', code: 'x <- 1' }
        })
      )
    ).toMatchObject({ actionTitle: 'Run R code?', categoryLabel: 'R execution' })
  })

  it('keeps unrecognized MCP requests in the external-service category', () => {
    expect(
      describePermissionRequest(request({ isMcp: true, toolKind: 'edit' })).categoryLabel
    ).toBe('External service')
    expect(
      describePermissionRequest(request({ isMcp: true, toolKind: 'fetch' })).categoryLabel
    ).toBe('External service')
  })

  it.each(['edit', 'delete', 'move'] as const)('classifies %s as a file change', (toolKind) => {
    expect(describePermissionRequest(request({ toolKind })).categoryLabel).toBe('File change')
  })
})
