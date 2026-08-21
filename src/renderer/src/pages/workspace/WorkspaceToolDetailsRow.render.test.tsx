// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ToolActivity } from '@/stores/session-store'
import type { NotebookRunRecord } from '../../../../shared/notebook'

import { buildToolActivityDetails } from './workspace-tool-activity-details'
import { WorkspaceToolDetailsRow } from './WorkspaceToolDetailsRow'
import { i18next } from '@/i18n'

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

const createNotebookRun = (overrides: Partial<NotebookRunRecord> = {}): NotebookRunRecord => ({
  runId: 'notebook-run-1',
  cellId: 'cell-1',
  source: 'agent',
  kernelKind: 'r',
  script: 'plot(1:3)',
  status: 'completed',
  startedAt: 1710000000000,
  text: { stdout: 'saved: plot.png\n', stderr: '', traceback: '', plain: [] },
  outputs: [{ type: 'display', data: { 'image/png': 'QUJD' } }],
  artifacts: [],
  workingFiles: [
    {
      path: '/workspace/plot.png',
      relativePath: 'plot.png',
      kind: 'other',
      createdByRunId: 'notebook-run-1'
    }
  ],
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

  it('renders a closed permission as neutral terminal metadata', async () => {
    const activity = createActivity({
      providerToolName: 'Bash',
      toolKind: 'execute',
      title: 'echo hi',
      status: 'in_progress',
      toolDisposition: 'permission-closed'
    })
    const details = buildToolActivityDetails(activity)

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceToolDetailsRow
          activity={activity}
          phase="closed"
          details={details!}
          isExpanded={false}
          onToggle={vi.fn()}
        />
      )
    })

    expect(container.textContent).toContain('request ended')
    expect(container.querySelector('.animate-spin')).toBeNull()
    expect(container.querySelector('[aria-live="polite"]')).toBeNull()
    expect(container.querySelector('.lucide-circle-minus')).not.toBeNull()
  })

  it('renders local notebook figures outside the independently collapsible text output', async () => {
    const activity = createActivity({
      providerToolName: 'mcp__open-science-notebook__notebook_execute',
      rawInput: { code: 'plot(1:3)', kernelKind: 'r' },
      rawOutput: {
        runId: 'notebook-run-1',
        status: 'completed',
        text: { stdout: 'saved: plot.png\n', stderr: '', traceback: '' }
      }
    })
    const details = buildToolActivityDetails(activity)
    const notebookRun = createNotebookRun()

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceToolDetailsRow
          activity={activity}
          details={details!}
          notebookRun={notebookRun}
          isExpanded={true}
          onToggle={vi.fn()}
        />
      )
    })

    const figures = container.querySelectorAll('[data-testid="notebook-figure-output"]')
    const figure = figures[0]
    const textOutput = Array.from(container.querySelectorAll('details')).find((detailsElement) =>
      detailsElement.textContent?.includes('Output')
    )

    expect(figure).not.toBeNull()
    expect(figures).toHaveLength(1)
    expect(figure?.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,QUJD')
    expect(figure?.firstElementChild?.className).toContain('justify-start')
    expect(textOutput?.contains(figure)).toBe(false)
    expect(container.textContent).toMatch(/1 figure/)
    expect(container.textContent).not.toContain('Saved:')
  })

  it('translates figure count meta', async () => {
    const activity = createActivity({
      providerToolName: 'mcp__open-science-notebook__notebook_execute',
      rawInput: { code: 'plot(1:3)', kernelKind: 'r' },
      rawOutput: {
        runId: 'notebook-run-1',
        status: 'completed',
        text: { stdout: 'saved: plot.png\n', stderr: '', traceback: '' }
      }
    })
    const details = buildToolActivityDetails(activity)
    const notebookRun = createNotebookRun()

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceToolDetailsRow
          activity={activity}
          details={details!}
          notebookRun={notebookRun}
          isExpanded={true}
          onToggle={vi.fn()}
        />
      )
    })

    expect(container.textContent).toMatch(/1 figure/)

    await act(async () => {
      await i18next.changeLanguage('zh-Hans')
    })

    expect(container.textContent).toContain('1 个图表')
    expect(container.textContent).toContain('Notebook 运行')
    expect(container.textContent).toContain('代码')
    expect(container.textContent).toContain('输出')
    expect(container.textContent).not.toMatch(/\d+ figures?/)

    await act(async () => {
      await i18next.changeLanguage('en')
    })
  })

  it('translates local approval phase metadata without translating provider data', async () => {
    const activity = createActivity({ providerToolName: 'Provider Custom Name' })

    root = createRoot(container)
    await act(async () => {
      await i18next.changeLanguage('zh-Hans')
      root.render(
        <WorkspaceToolDetailsRow
          activity={activity}
          phase="awaiting-approval"
          details={{
            displayName: 'Write file',
            sections: [{ kind: 'code', label: 'Output', text: 'provider payload' }]
          }}
          isExpanded={true}
          onToggle={vi.fn()}
        />
      )
    })

    expect(container.textContent).toContain('写入文件')
    expect(container.textContent).toContain('正在等待你的批准')
    expect(container.textContent).toContain('输出')
    expect(container.textContent).toContain('provider payload')

    await act(async () => {
      await i18next.changeLanguage('en')
    })
  })
})
