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
          isMcp: true
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
          isMcp: true
        })
      )
    ).toMatchObject({
      actionTitle: 'View notebook runtimes?',
      description: 'Lists the notebook runtimes available to this conversation.'
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
          title: 'mcp__open-science-artifacts__write_artifact_file',
          isMcp: true
        })
      ).actionDetail
    ).toBe('Open Science Artifacts / Write Artifact File')
  })

  it('classifies a raw MCP protocol name even when the provider omits isMcp', () => {
    expect(
      describePermissionRequest(
        request({
          title: 'mcp__open-science-artifacts__write_artifact_file',
          isMcp: false,
          toolKind: 'execute'
        })
      )
    ).toMatchObject({
      actionTitle: 'Use external service?',
      categoryLabel: 'External service',
      actionDetail: 'Open Science Artifacts / Write Artifact File'
    })
  })

  it('uses the provider identity when an MCP title is generic', () => {
    expect(
      describePermissionRequest(
        request({
          title: 'Run MCP tool',
          providerToolName: 'mcp__open-science-artifacts__write_artifact_file',
          isMcp: true
        })
      ).actionDetail
    ).toBe('Open Science Artifacts / Write Artifact File')
  })

  it('does not split dots in a human-readable MCP title', () => {
    expect(
      describePermissionRequest(request({ title: 'Write report.md', isMcp: true })).actionDetail
    ).toBe('Write report.md')
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
