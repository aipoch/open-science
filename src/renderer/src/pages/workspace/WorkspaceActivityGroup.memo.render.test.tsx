// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { i18next } from '@/i18n'
import type { ToolActivity } from '@/stores/session-store'
import { WorkspaceActivityGroup } from './WorkspaceActivityGroup'
import * as details from './workspace-tool-activity-details'

const { stopAutoScroll, renderDetails } = vi.hoisted(() => ({
  stopAutoScroll: vi.fn(),
  renderDetails: vi.fn()
}))
vi.mock('@/components/ui/message-scroller', () => ({
  MessageScrollerItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useMessageScroller: () => ({ stopAutoScroll })
}))
vi.mock('./WorkspaceToolDetailsRow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./WorkspaceToolDetailsRow')>()
  return {
    WorkspaceToolDetailsRow: (props: ComponentProps<typeof actual.WorkspaceToolDetailsRow>) => {
      renderDetails(props.activity.id)
      return <actual.WorkspaceToolDetailsRow {...props} />
    }
  }
})

const activity = (id: string): ToolActivity => ({
  id,
  kind: 'tool',
  title: 'Command',
  toolKind: 'execute',
  status: 'completed',
  eventIds: [],
  sortIndex: 1,
  createdAt: 1,
  updatedAt: 2,
  rawInput: { command: `echo ${id}` },
  rawOutput: `${id} result`,
  terminalExitCode: 0
})

beforeEach(async () => {
  await i18next.changeLanguage('en')
  vi.clearAllMocks()
})
afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  await i18next.changeLanguage('en')
})

it('skips unchanged tool details across fresh group wrappers and only updates the changed row', () => {
  const first = activity('first')
  const second = activity('second')
  const onToggleRow = vi.fn()
  const onToggleGroup = vi.fn()
  const build = vi.spyOn(details, 'buildToolActivityDetails')
  const group = (rows: ToolActivity[], overrides: Record<string, boolean> = {}): ReactNode => (
    <WorkspaceActivityGroup
      group={{ id: 'group', type: 'activity-group', createdAt: 1, sortIndex: 1, activities: rows }}
      isExpanded
      expansionOverrides={overrides}
      onToggleRow={onToggleRow}
      onToggleGroup={onToggleGroup}
    />
  )
  const view = render(group([first, second]))
  expect(build).toHaveBeenCalledTimes(2)
  expect(renderDetails.mock.calls.map(([id]) => id)).toEqual(['first', 'second'])

  // A new timeline/group/activities array does not mean these historical tool records changed.
  view.rerender(group([first, second]))
  view.rerender(group([first, second]))
  expect(build).toHaveBeenCalledTimes(2)
  expect(renderDetails).toHaveBeenCalledTimes(2)

  view.rerender(group([first, second], { first: true }))
  expect(build).toHaveBeenCalledTimes(2)
  expect(renderDetails.mock.calls.map(([id]) => id)).toEqual(['first', 'second', 'first'])
  expect(screen.getByText('first result')).toBeTruthy()
  fireEvent.click(screen.getAllByTestId('tool-chip')[0])
  expect(onToggleRow).toHaveBeenCalledWith('first', false)
  expect(stopAutoScroll).toHaveBeenCalledOnce()

  // A real receipt replaces records. Even an unchanged timestamp must not hide changed output.
  const changed = { ...first, rawOutput: 'new authoritative result' }
  view.rerender(group([changed, second], { first: true }))
  expect(build).toHaveBeenCalledTimes(3)
  expect(renderDetails.mock.calls.map(([id]) => id)).toEqual(['first', 'second', 'first', 'first'])
  expect(screen.getByText('new authoritative result')).toBeTruthy()
  expect(screen.queryByText('first result')).toBeNull()
})

it('keeps translation and changed action callbacks live for memoized tool rows', async () => {
  const tool = activity('tool')
  const onToggleGroup = vi.fn()
  const firstToggle = vi.fn()
  const nextToggle = vi.fn()
  const build = vi.spyOn(details, 'buildToolActivityDetails')
  const group = (onToggleRow: typeof firstToggle): ReactNode => (
    <WorkspaceActivityGroup
      group={{
        id: 'group',
        type: 'activity-group',
        createdAt: 1,
        sortIndex: 1,
        activities: [tool]
      }}
      isExpanded
      expansionOverrides={{}}
      onToggleRow={onToggleRow}
      onToggleGroup={onToggleGroup}
    />
  )
  const view = render(group(firstToggle))
  expect(screen.getByTestId('tool-chip').textContent).toContain('exit 0')
  expect(build).toHaveBeenCalledTimes(1)
  await act(() => i18next.changeLanguage('zh-Hans'))
  expect(screen.getByTestId('tool-chip').textContent).toContain('退出码 0')
  expect(build).toHaveBeenCalledTimes(2)

  view.rerender(group(nextToggle))
  expect(build).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByTestId('tool-chip'))
  expect(firstToggle).not.toHaveBeenCalled()
  expect(nextToggle).toHaveBeenCalledWith('tool', true)
})
