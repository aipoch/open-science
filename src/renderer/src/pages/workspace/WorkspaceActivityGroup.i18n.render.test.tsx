// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18next } from '@/i18n'
import type { NotebookRunRecord } from '../../../../shared/notebook'
import { WorkspaceActivityGroup } from './WorkspaceActivityGroup'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/ui/message-scroller', () => ({
  MessageScrollerItem: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  act(() => root.unmount())
  container.remove()
  await i18next.changeLanguage('en')
})

describe('WorkspaceActivityGroup i18n', () => {
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
