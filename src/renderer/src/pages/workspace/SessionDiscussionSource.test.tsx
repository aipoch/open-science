// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { SessionRuntimeContext } from '../../../../shared/session-runtime-context'
import { SessionDiscussionSource } from './SessionDiscussionSource'

const mocks = vi.hoisted(() => ({ read: vi.fn(), unlink: vi.fn(), seek: vi.fn(), open: vi.fn() }))
vi.mock('@/stores/navigation-store', () => ({
  useNavigationStore: { getState: () => ({ activeProjectId: 'project' }) }
}))
vi.mock('@/stores/session-store', () => ({
  useSessionStore: { getState: () => ({ selectedSessionId: 'receiving' }) }
}))
vi.mock('@/stores/preview-workbench-store', () => ({
  usePreviewWorkbenchStore: { getState: () => ({ upsertAndActivateItem: mocks.open }) }
}))
vi.mock('./workspace-session-actions', () => ({
  createSessionReplayItem: (projectId: string, sessionId: string) => ({ projectId, sessionId })
}))
vi.mock('./replay/replay-context', () => ({ requestReplaySeek: mocks.seek }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
const binding = {
  projectId: 'project',
  sessionId: 'source',
  contextId: 'latest',
  title: 'Analysis',
  branchId: 'main',
  promptMessageId: 'prompt',
  positions: [{ contextId: 'latest', branchId: 'main', stepTitle: 'R chart' }]
}
const context = (bindings = [binding]): SessionRuntimeContext => ({
  version: 1,
  revision: 2,
  sessionContext: { version: 1, bindings }
})
const render = async (value = context()): Promise<void> => {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <SessionDiscussionSource projectId="project" sessionId="receiving" context={value} />
      </TooltipProvider>
    )
  )
}
const button = (text: string): HTMLButtonElement =>
  Array.from(document.querySelectorAll('button')).find((node) => node.textContent?.includes(text))!
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('api', undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { sessionReplay: { getSelectionSnapshot: mocks.read, unlinkSession: mocks.unlink } }
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

it('shows the selected step and loading feedback until its original position is open', async () => {
  let finish!: (value: unknown) => void
  mocks.read.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  await render()
  await act(async () => button('Analysis').click())
  expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
  expect(button('Analysis').disabled).toBe(true)
  await act(async () => finish({ stepId: 'original', stepOffsetMs: 120 }))
  expect(mocks.seek).toHaveBeenCalledWith({ stepId: 'original', stepOffsetMs: 120 })
  expect(button('Analysis').disabled).toBe(false)
})

it('offers retry without exposing internal errors and keeps unlink available', async () => {
  mocks.read
    .mockRejectedValueOnce(new Error('SQLITE_INTERNAL /private/path'))
    .mockResolvedValueOnce({ stepId: 'original' })
  await render()
  await act(async () => button('Analysis').click())
  expect(container.textContent).toContain('Could not open this source')
  expect(container.textContent).not.toContain('SQLITE_INTERNAL')
  await act(async () => button('Retry').click())
  expect(mocks.seek).toHaveBeenCalledOnce()
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Unlink Session"]')!.click()
  )
  expect(mocks.unlink).toHaveBeenCalledWith({
    projectId: 'project',
    sessionId: 'receiving',
    sourceSessionId: 'source',
    expectedRevision: 2
  })
})

it('opens each selected step rather than silently returning to the latest one', async () => {
  mocks.read.mockImplementation(async ({ id }) => ({ stepId: id }))
  await render(
    context([
      {
        ...binding,
        positions: [
          { contextId: 'first', branchId: 'main', stepTitle: 'Python chart' },
          ...binding.positions
        ]
      }
    ])
  )
  await act(async () => button('Question scope').click())
  expect(document.body.textContent).toContain('Selected steps')
  await act(async () => button('Python chart').click())
  expect(mocks.read).toHaveBeenCalledWith({ projectId: 'project', id: 'first' })
  expect(mocks.seek).toHaveBeenCalledWith({ stepId: 'first', stepOffsetMs: 0 })
})

it('shows only the latest source from older multi-Session state', async () => {
  await render(
    context([
      binding,
      { ...binding, sessionId: 'second', title: 'Second' },
      { ...binding, sessionId: 'third', title: 'Third' }
    ])
  )
  expect(container.textContent).toContain('Third')
  expect(container.textContent).not.toContain('Second')
  expect(container.textContent).not.toContain('Analysis')
  expect(container.querySelectorAll('[data-session-discussion-source]')).toHaveLength(1)
  expect(container.textContent).toContain('Question scope')
})

it('shows the whole-research scope on the source chip before opening its details', async () => {
  const value = context()
  value.sessionContext!.bindings[0].scope = 'session'
  await render(value)
  expect(button('Analysis').textContent).toContain('Entire research')
  expect(button('Analysis').textContent).not.toContain('steps')
  await act(async () => button('Question scope').click())
  expect(document.body.textContent).toContain('Entire research')
  expect(document.body.textContent).not.toContain('Selected steps')
})
