// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNavigationStore } from '@/stores/navigation-store'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { ReplayReferenceText } from './ReplayReferenceText'
import { replayReferenceText } from './replay-reference-text'
import { consumeReplaySeek } from './replay/replay-context'

const translate = (text: string): string => text
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const id = '11111111-1111-4111-8111-111111111111'
const context = {
  projectId: 'p',
  sourceSessionId: 'source',
  branchId: 'branch',
  stepId: 'step',
  stepOffsetMs: 200
}
let root: Root
let container: HTMLDivElement
let get: ReturnType<typeof vi.fn>
beforeEach(() => {
  useNavigationStore.setState({
    view: 'workspace',
    activeProjectId: 'p',
    explicitNavigationRevision: 1
  })
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  usePreviewWorkbenchStore.getState().activateProject('p')
  consumeReplaySeek('p', 'source')
  get = vi.fn().mockResolvedValue(context)
  window.api = { researchWorkspaces: { getQuestionContext: get } } as unknown as typeof window.api
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
const render = async (): Promise<void> => {
  await act(async () =>
    root.render(
      createElement(ReplayReferenceText, {
        projectId: 'p',
        text: replayReferenceText(id, 'Recorded step')
      })
    )
  )
}
describe('saved replay reference navigation', () => {
  it('opens the exact saved source and step without changing the left discussion', async () => {
    await render()
    await act(async () => container.querySelector('button')!.click())
    expect(get).toHaveBeenCalledWith({ projectId: 'p', id })
    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe('tool:source:replay')
    expect(consumeReplaySeek('p', 'source')).toMatchObject(context)
    expect(useNavigationStore.getState().explicitNavigationRevision).toBe(1)
  })
  it('does not steal navigation when an asynchronous lookup completes after leaving', async () => {
    let resolve!: (value: typeof context) => void
    get.mockReturnValue(
      new Promise((r) => {
        resolve = r
      })
    )
    await render()
    await act(async () => container.querySelector('button')!.click())
    await act(async () => {
      useNavigationStore.setState({ view: 'home', explicitNavigationRevision: 2 })
      resolve(context)
    })
    expect(usePreviewWorkbenchStore.getState().items).toHaveLength(0)
    expect(consumeReplaySeek('p', 'source')).toBeUndefined()
  })
  it('keeps a readable label and explains a missing local mapping', async () => {
    get.mockResolvedValue(undefined)
    await render()
    await act(async () => container.querySelector('button')!.click())
    expect(container.textContent).toContain('Recorded step')
    expect(container.textContent).toContain('This replay reference is unavailable on this device.')
    expect(usePreviewWorkbenchStore.getState().items).toHaveLength(0)
  })
})
