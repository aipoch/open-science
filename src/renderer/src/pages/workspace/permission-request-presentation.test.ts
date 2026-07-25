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
    ).toEqual({
      actionTitle: 'Restart notebook?',
      categoryLabel: 'Notebook control',
      description:
        'Restarts the current notebook environment. Running processes and unsaved runtime state may be lost.'
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
})
