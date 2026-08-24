// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18next } from '@/i18n'
import type { NotebookRunRecord } from '../../../../shared/notebook'
import { WorkspaceActivityGroup } from './WorkspaceActivityGroup'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { scrollToMessage } = vi.hoisted(() => ({ scrollToMessage: vi.fn() }))

vi.mock('@/components/ui/message-scroller', () => ({
  MessageScrollerItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useMessageScroller: () => ({ scrollToMessage })
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  scrollToMessage.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  vi.useRealTimers()
  act(() => root.unmount())
  container.remove()
  await i18next.changeLanguage('en')
})

describe('WorkspaceActivityGroup i18n', () => {
  it('renders active manage_packages progress inside its tool group', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T00:02:05Z'))
    const createdAt = Date.now() - 65_000

    act(() => {
      root.render(
        <WorkspaceActivityGroup
          group={{
            id: 'group-packages-1',
            type: 'activity-group',
            createdAt,
            sortIndex: 1,
            activities: [
              {
                id: 'activity-packages-1',
                kind: 'tool',
                title: 'open-science-notebook.manage_packages',
                status: 'in_progress',
                eventIds: [],
                sortIndex: 1,
                createdAt,
                updatedAt: createdAt,
                rawInput: {
                  arguments: {
                    language: 'python',
                    packages: ['numpy', 'pandas'],
                    operation: 'uninstall'
                  }
                }
              }
            ]
          }}
          isExpanded={true}
          onToggleGroup={vi.fn()}
          expansionOverrides={{}}
          onToggleRow={vi.fn()}
        />
      )
    })

    const progress = container.querySelector('[data-testid="manage-packages-progress"]')
    expect(container.querySelector('[data-testid="tool-group"]')?.contains(progress)).toBe(true)
    expect(progress?.textContent).toContain('Removing 2 packages')
    expect(progress?.textContent).toContain('Removing…')
    expect(progress?.textContent).not.toContain('Installing…')
    expect(progress?.textContent).toContain('Python · conda')
    expect(progress?.textContent).toContain('This can take several minutes')
    expect(progress?.textContent).toContain('1:05')
    expect(progress?.querySelectorAll('[data-testid="manage-packages-package-row"]')).toHaveLength(
      2
    )
    expect(progress?.textContent).toContain('numpy')
    expect(progress?.textContent).toContain('pandas')
    expect(progress?.textContent).toContain('PackageStatusVersion')
    expect(progress?.textContent).not.toContain('Notebook · manage_packages')
    expect(progress?.textContent).not.toContain('Running')
    expect(progress?.querySelector('.bg-status-info-foreground')).not.toBeNull()
    expect(container.querySelector('[data-testid="tool-details"]')).toBeNull()
  })

  it('keeps a terminal package row collapsed until the user expands it', () => {
    const onToggleRow = vi.fn()
    act(() => {
      root.render(
        <WorkspaceActivityGroup
          group={{
            id: 'group-packages-collapsed',
            type: 'activity-group',
            createdAt: 1,
            sortIndex: 1,
            activities: [
              {
                id: 'activity-packages-collapsed',
                kind: 'tool',
                title: 'open-science-notebook.manage_packages',
                status: 'completed',
                eventIds: [],
                sortIndex: 1,
                createdAt: 1,
                updatedAt: 8_000,
                rawInput: { language: 'python', packages: ['numpy'] },
                rawOutput: {
                  ok: true,
                  packageChanges: [
                    { name: 'numpy', relationship: 'requested', change: 'installed' }
                  ]
                }
              }
            ]
          }}
          isExpanded={true}
          onToggleGroup={vi.fn()}
          expansionOverrides={{}}
          onToggleRow={onToggleRow}
        />
      )
    })

    expect(container.querySelector('[data-testid="manage-packages-package-row"]')).toBeNull()
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="manage-packages-progress"] > button')
        ?.click()
    )
    expect(onToggleRow).toHaveBeenCalledWith('activity-packages-collapsed', true)
  })

  it('keeps the manage_packages presentation after the tool completes', () => {
    act(() => {
      root.render(
        <WorkspaceActivityGroup
          group={{
            id: 'group-packages-completed',
            type: 'activity-group',
            createdAt: 1,
            sortIndex: 1,
            activities: [
              {
                id: 'activity-packages-completed',
                kind: 'tool',
                title: 'open-science-notebook.manage_packages',
                status: 'completed',
                eventIds: [],
                sortIndex: 1,
                createdAt: 1,
                updatedAt: 46_000,
                rawInput: { language: 'r', packages: ['ggplot2'] },
                rawOutput: {
                  structuredContent: {
                    ok: true,
                    needsRestart: true,
                    method: 'conda',
                    environmentName: 'analysis-r',
                    packageChanges: [
                      {
                        name: 'ggplot2',
                        change: 'unchanged',
                        afterVersion: '4.0.3'
                      }
                    ]
                  }
                }
              }
            ]
          }}
          isExpanded={true}
          onToggleGroup={vi.fn()}
          expansionOverrides={{ 'activity-packages-completed': true }}
          onToggleRow={vi.fn()}
        />
      )
    })

    expect(container.querySelector('[data-testid="manage-packages-progress"]')).not.toBeNull()
    expect(container.textContent).toContain('Installed 1 package')
    expect(container.textContent).toContain('R · analysis-r · conda')
    expect(
      container.querySelector('[data-testid="manage-packages-package-status"]')?.textContent
    ).toBe('Unchanged')
    expect(
      container.querySelector('[data-testid="manage-packages-package-version"]')?.textContent
    ).toBe('4.0.3')
    expect(container.textContent).toContain('Installed R packages need a kernel restart to load.')
    expect(container.textContent).not.toContain('Completed')
    expect(container.querySelector('.text-status-warning-foreground')).not.toBeNull()
    expect(container.querySelector('.bg-status-warning-foreground')).toBeNull()
    expect(container.textContent).not.toContain('manage_packages()')
  })

  it('shows the version transition for an updated package', () => {
    act(() => {
      root.render(
        <WorkspaceActivityGroup
          group={{
            id: 'group-packages-updated',
            type: 'activity-group',
            createdAt: 1,
            sortIndex: 1,
            activities: [
              {
                id: 'activity-packages-updated',
                kind: 'tool',
                title: 'open-science-notebook.manage_packages',
                status: 'completed',
                eventIds: [],
                sortIndex: 1,
                createdAt: 1,
                updatedAt: 8_000,
                rawInput: { language: 'python', packages: ['pandas'], usePip: true },
                rawOutput: {
                  ok: true,
                  needsRestart: false,
                  method: 'pip',
                  environmentName: 'analysis',
                  packageChanges: [
                    {
                      name: 'pandas',
                      change: 'updated',
                      beforeVersion: '2.2.2',
                      afterVersion: '2.3.1'
                    }
                  ]
                }
              }
            ]
          }}
          isExpanded={true}
          onToggleGroup={vi.fn()}
          expansionOverrides={{ 'activity-packages-updated': true }}
          onToggleRow={vi.fn()}
        />
      )
    })

    expect(container.textContent).toContain('Python · analysis · pip')
    expect(
      container.querySelector('[data-testid="manage-packages-package-status"]')?.textContent
    ).toBe('Updated')
    expect(
      container.querySelector('[data-testid="manage-packages-package-version"]')?.textContent
    ).toBe('2.2.2 → 2.3.1')
    expect(container.querySelector('.install-progress-indeterminate')).toBeNull()
  })

  it('uses removal-specific restart guidance after an R uninstall', () => {
    act(() => {
      root.render(
        <WorkspaceActivityGroup
          group={{
            id: 'group-packages-removed',
            type: 'activity-group',
            createdAt: 1,
            sortIndex: 1,
            activities: [
              {
                id: 'activity-packages-removed',
                kind: 'tool',
                title: 'open-science-notebook.manage_packages',
                status: 'completed',
                eventIds: [],
                sortIndex: 1,
                createdAt: 1,
                updatedAt: 8_000,
                rawInput: { language: 'r', packages: ['ggplot2'], operation: 'uninstall' },
                rawOutput: {
                  structuredContent: {
                    ok: true,
                    needsRestart: true,
                    method: 'conda',
                    environmentName: 'analysis-r',
                    packageChanges: [
                      {
                        name: 'ggplot2',
                        change: 'removed',
                        beforeVersion: '4.0.3'
                      }
                    ]
                  }
                }
              }
            ]
          }}
          isExpanded={true}
          onToggleGroup={vi.fn()}
          expansionOverrides={{ 'activity-packages-removed': true }}
          onToggleRow={vi.fn()}
        />
      )
    })

    expect(container.textContent).toContain('Removed 1 package')
    expect(container.textContent).toContain('Removed R packages need a kernel restart to unload.')
    expect(container.textContent).not.toContain(
      'Installed R packages need a kernel restart to load.'
    )
  })

  it('shows a verified GitHub package and keeps related changes collapsed', () => {
    act(() => {
      root.render(
        <WorkspaceActivityGroup
          group={{
            id: 'group-packages-github',
            type: 'activity-group',
            createdAt: 1,
            sortIndex: 1,
            activities: [
              {
                id: 'activity-packages-github',
                kind: 'tool',
                title: 'open-science-notebook.manage_packages',
                status: 'completed',
                eventIds: [],
                sortIndex: 1,
                createdAt: 1,
                updatedAt: 8_000,
                rawInput: {
                  language: 'r',
                  packages: ['tidyverse/ggplot2@main'],
                  installer: 'github'
                },
                rawOutput: {
                  structuredContent: {
                    ok: true,
                    needsRestart: true,
                    method: 'github',
                    environmentName: 'analysis-r',
                    packageChanges: [
                      {
                        name: 'ggplot2',
                        relationship: 'requested',
                        change: 'installed',
                        afterVersion: '4.0.0.9000',
                        source: {
                          type: 'github',
                          repository: 'tidyverse/ggplot2',
                          ref: 'main',
                          commit: 'a7b92f1'
                        }
                      },
                      {
                        name: 'S7',
                        relationship: 'unattributed',
                        change: 'updated',
                        beforeVersion: '0.1.0',
                        afterVersion: '0.2.0'
                      }
                    ]
                  }
                }
              }
            ]
          }}
          isExpanded={true}
          onToggleGroup={vi.fn()}
          expansionOverrides={{ 'activity-packages-github': true }}
          onToggleRow={vi.fn()}
        />
      )
    })

    const progress = container.querySelector('[data-testid="manage-packages-progress"]')
    expect(progress?.textContent).toContain('R · analysis-r · GitHub')
    expect(progress?.textContent).toContain('ggplot2')
    expect(progress?.textContent).toContain('4.0.0.9000')
    expect(progress?.textContent).toContain('tidyverse/ggplot2@main')
    expect(progress?.textContent).toContain('Related changes')
    expect(progress?.querySelector('details')?.hasAttribute('open')).toBe(false)
    expect(
      progress?.querySelector('[data-testid="manage-packages-related-row"]')?.textContent
    ).toContain('S7')
  })

  it('renders a completed tool with ok false as a package failure', () => {
    act(() => {
      root.render(
        <WorkspaceActivityGroup
          group={{
            id: 'group-packages-failed-result',
            type: 'activity-group',
            createdAt: 1,
            sortIndex: 1,
            activities: [
              {
                id: 'activity-packages-failed-result',
                kind: 'tool',
                title: 'open-science-notebook.manage_packages',
                status: 'completed',
                eventIds: [],
                sortIndex: 1,
                createdAt: 1,
                updatedAt: 8_000,
                rawInput: { language: 'python', packages: ['numpy'] },
                rawOutput: {
                  structuredContent: {
                    ok: false,
                    needsRestart: false,
                    method: 'conda',
                    environmentName: 'analysis',
                    error: 'The analysis environment is read-only.'
                  }
                }
              }
            ]
          }}
          isExpanded={true}
          onToggleGroup={vi.fn()}
          expansionOverrides={{ 'activity-packages-failed-result': true }}
          onToggleRow={vi.fn()}
        />
      )
    })

    const progress = container.querySelector('[data-testid="manage-packages-progress"]')
    expect(progress?.textContent).toContain('Installing 1 package')
    expect(progress?.textContent).toContain('The analysis environment is read-only.')
    expect(progress?.querySelector('.text-status-failure-foreground')).not.toBeNull()
    expect(progress?.querySelector('.text-status-success-foreground')).toBeNull()
    expect(progress?.querySelector('.install-progress-indeterminate')).toBeNull()
  })

  it('keeps every requested package visible when only some have change records', () => {
    act(() => {
      root.render(
        <WorkspaceActivityGroup
          group={{
            id: 'group-packages-partial-failure',
            type: 'activity-group',
            createdAt: 1,
            sortIndex: 1,
            activities: [
              {
                id: 'activity-packages-partial-failure',
                kind: 'tool',
                title: 'open-science-notebook.manage_packages',
                status: 'failed',
                eventIds: [],
                sortIndex: 1,
                createdAt: 1,
                updatedAt: 8_000,
                rawInput: { language: 'python', packages: ['numpy', 'missingpkg'] },
                rawOutput: {
                  ok: false,
                  method: 'conda',
                  packageChanges: [
                    {
                      name: 'numpy',
                      relationship: 'requested',
                      change: 'installed',
                      afterVersion: '2.1.0'
                    }
                  ]
                }
              }
            ]
          }}
          isExpanded={true}
          onToggleGroup={vi.fn()}
          expansionOverrides={{ 'activity-packages-partial-failure': true }}
          onToggleRow={vi.fn()}
        />
      )
    })

    const rows = container.querySelectorAll('[data-testid="manage-packages-package-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('numpy')
    expect(rows[0]?.textContent).toContain('Installed')
    expect(rows[1]?.textContent).toContain('missingpkg')
    expect(rows[1]?.textContent).toContain('Failed')
  })

  it('preserves a plain-text package failure detail', () => {
    act(() => {
      root.render(
        <WorkspaceActivityGroup
          group={{
            id: 'group-packages-plain-failure',
            type: 'activity-group',
            createdAt: 1,
            sortIndex: 1,
            activities: [
              {
                id: 'activity-packages-plain-failure',
                kind: 'tool',
                title: 'open-science-notebook.manage_packages',
                status: 'failed',
                eventIds: [],
                sortIndex: 1,
                createdAt: 1,
                updatedAt: 8_000,
                rawInput: { language: 'python', packages: ['numpy'] },
                rawOutput: 'PackagesNotFoundError: numpy is unavailable for this environment.'
              }
            ]
          }}
          isExpanded={true}
          onToggleGroup={vi.fn()}
          expansionOverrides={{ 'activity-packages-plain-failure': true }}
          onToggleRow={vi.fn()}
        />
      )
    })

    const progress = container.querySelector('[data-testid="manage-packages-progress"]')
    expect(progress?.textContent).toContain(
      'PackagesNotFoundError: numpy is unavailable for this environment.'
    )
  })

  it('anchors the group in view before toggling its height', () => {
    const onToggleGroup = vi.fn()
    act(() => {
      root.render(
        <WorkspaceActivityGroup
          group={{
            id: 'group-anchor-1',
            type: 'activity-group',
            createdAt: 1,
            sortIndex: 1,
            activities: [
              {
                id: 'activity-anchor-1',
                kind: 'tool',
                title: 'Bash',
                status: 'completed',
                eventIds: [],
                sortIndex: 1,
                createdAt: 1,
                updatedAt: 2,
                toolKind: 'execute',
                providerToolName: 'bash',
                rawInput: { command: 'pwd' },
                rawOutput: 'done'
              }
            ]
          }}
          isExpanded={false}
          onToggleGroup={onToggleGroup}
          expansionOverrides={{}}
          onToggleRow={vi.fn()}
        />
      )
    })

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="tool-group-header"]')?.click()
    })

    expect(scrollToMessage).toHaveBeenCalledWith('group-anchor-1', {
      align: 'nearest',
      behavior: 'auto'
    })
    expect(scrollToMessage.mock.invocationCallOrder[0]).toBeLessThan(
      onToggleGroup.mock.invocationCallOrder[0]!
    )
  })

  it('re-renders a completed group when the interface language changes', async () => {
    act(() => {
      root.render(
        <WorkspaceActivityGroup
          group={{
            id: 'group-1',
            type: 'activity-group',
            createdAt: 1,
            sortIndex: 1,
            activities: [
              {
                id: 'activity-1',
                kind: 'tool',
                title: 'Bash',
                status: 'completed',
                eventIds: [],
                sortIndex: 1,
                createdAt: 1,
                updatedAt: 2,
                toolKind: 'execute',
                providerToolName: 'bash',
                rawInput: { command: 'pwd' },
                rawOutput: 'done'
              }
            ]
          }}
          isExpanded={true}
          onToggleGroup={vi.fn()}
          expansionOverrides={{ 'activity-1': true }}
          onToggleRow={vi.fn()}
        />
      )
    })

    expect(container.textContent).toContain('Ran a command')
    expect(container.textContent).toContain('Command')
    expect(container.textContent).toContain('Output')
    await act(async () => i18next.changeLanguage('zh-Hans'))
    expect(container.textContent).toContain('运行了一个命令')
    expect(container.textContent).toContain('命令')
    expect(container.textContent).toContain('输出')
    expect(container.textContent).not.toContain('Ran a command')
    expect(container.textContent).not.toContain('Command')
  })

  it('lets the tool group collapse a figure that remains visible beside a collapsed tool row', () => {
    const activity = {
      id: 'activity-notebook-1',
      kind: 'tool' as const,
      title: 'Render plot',
      status: 'completed' as const,
      eventIds: [],
      sortIndex: 1,
      createdAt: 1,
      updatedAt: 2,
      toolKind: 'execute' as const,
      providerToolName: 'mcp__open-science-notebook__notebook_execute',
      executionInvocationId: 'invocation-1',
      rawInput: { code: 'plot(1:3)', kernelKind: 'r' },
      rawOutput: { runId: 'run-figure-1', status: 'completed' }
    }
    const group = {
      id: 'group-notebook-1',
      type: 'activity-group' as const,
      createdAt: 1,
      sortIndex: 1,
      activities: [activity]
    }
    const run: NotebookRunRecord = {
      runId: 'run-figure-1',
      executionInvocationId: 'invocation-1',
      cellId: 'cell-1',
      source: 'agent',
      kernelKind: 'r',
      script: 'plot(1:3)',
      status: 'completed',
      startedAt: 1,
      endedAt: 2,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [{ type: 'display', data: { 'image/png': 'QUJD' } }],
      artifacts: [],
      workingFiles: []
    }
    const renderGroup = (isExpanded: boolean): void => {
      root.render(
        <WorkspaceActivityGroup
          group={group}
          isExpanded={isExpanded}
          onToggleGroup={vi.fn()}
          expansionOverrides={{}}
          onToggleRow={vi.fn()}
          notebookRunsById={new Map([[run.runId, run]])}
        />
      )
    }

    act(() => renderGroup(true))

    expect(container.querySelector('[data-testid="tool-details"]')).toBeNull()
    expect(container.querySelector('[data-testid="notebook-tool-figure-button"]')).not.toBeNull()
    expect(container.textContent).toContain('1 figure · done')

    act(() => renderGroup(false))

    expect(container.querySelector('[data-testid="notebook-tool-figure-button"]')).toBeNull()
  })
})
