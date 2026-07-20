// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ToolActivity } from '@/stores/session-store'

import { buildToolActivityDetails } from './workspace-tool-activity-details'
import { WorkspaceToolDetailsRow } from './WorkspaceToolDetailsRow'

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

describe('WorkspaceToolDetailsRow', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    vi.clearAllMocks()
  })

  it('renders an image artifact-write result as an inline image preview', async () => {
    window.api = {
      artifacts: {
        openFile: vi.fn(),
        readPreview: vi.fn().mockResolvedValue({
          content: 'aGVsbG8=',
          encoding: 'base64',
          size: 6,
          truncated: false
        }),
        finalizeRunArtifacts: vi.fn()
      }
    } as unknown as Window['api']

    const activity = createActivity({
      providerToolName: 'write_artifact_file',
      toolKind: 'other',
      title: 'Write artifact file',
      rawInput: { filename: 'sin_curve.png', mimeType: 'image/png' },
      toolContent: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: JSON.stringify({
              artifact: {
                name: 'sin_curve.png',
                path: '/artifacts/.pending/run-1/sin_curve.png',
                mimeType: 'image/png',
                size: 57344
              }
            })
          }
        }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.sections[0]?.kind).toBe('image')

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceToolDetailsRow
          activity={activity}
          details={details!}
          isExpanded={true}
          onToggle={vi.fn()}
        />
      )
    })

    expect(window.api.artifacts.readPreview).toHaveBeenCalledWith({
      path: '/artifacts/.pending/run-1/sin_curve.png',
      maxBytes: 10 * 1024 * 1024,
      encoding: 'base64',
      // #147 added paginated reads; usePreviewFileContent now passes the page offset.
      offset: 0
    })

    const image = container.querySelector('[data-testid="tool-output-image"]')
    expect(image?.getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=')
    expect(container.textContent).toContain('sin_curve.png')
    expect(container.textContent).toContain('56 KB')
  })

  it('falls back to the filename while the image preview is still loading', async () => {
    let resolveRead: ((value: unknown) => void) | undefined
    window.api = {
      artifacts: {
        openFile: vi.fn(),
        readPreview: vi.fn().mockReturnValue(
          new Promise((resolve) => {
            resolveRead = resolve
          })
        ),
        finalizeRunArtifacts: vi.fn()
      }
    } as unknown as Window['api']

    const activity = createActivity({
      providerToolName: 'write_artifact_file',
      toolKind: 'other',
      rawInput: { filename: 'sin_curve.png', mimeType: 'image/png' },
      toolContent: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: JSON.stringify({
              artifact: {
                name: 'sin_curve.png',
                path: '/artifacts/.pending/run-1/sin_curve.png',
                mimeType: 'image/png',
                size: 57344
              }
            })
          }
        }
      ]
    })
    const details = buildToolActivityDetails(activity)

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceToolDetailsRow
          activity={activity}
          details={details!}
          isExpanded={true}
          onToggle={vi.fn()}
        />
      )
    })

    expect(container.querySelector('[data-testid="tool-output-image"]')).toBeNull()
    expect(container.textContent).toContain('Loading preview')

    await act(async () => {
      resolveRead?.({ content: 'aGVsbG8=', encoding: 'base64', size: 6, truncated: false })
    })

    expect(container.querySelector('[data-testid="tool-output-image"]')).not.toBeNull()
  })

  it('renders a non-image, non-JSON tool output as a code section', async () => {
    const activity = createActivity({
      providerToolName: 'Bash',
      toolKind: 'execute',
      title: 'echo hi',
      terminalOutput: 'hi',
      terminalExitCode: 0
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.sections.some((section) => section.kind === 'image')).toBe(false)
    expect(details?.sections[1]?.kind).toBe('code')

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceToolDetailsRow
          activity={activity}
          details={details!}
          isExpanded={true}
          onToggle={vi.fn()}
        />
      )
    })

    expect(container.querySelector('[data-testid="tool-output-image"]')).toBeNull()
    expect(container.querySelectorAll('[data-testid="tool-code-block"]').length).toBeGreaterThan(0)
    expect(container.textContent).toContain('hi')
  })
})
