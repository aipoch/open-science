// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStore, type ChatSession } from '@/stores/session-store'
import { createI18nTestStub } from '../../../../../test/i18n-test-stub'
import { ResearchMembershipDialog } from './ResearchMembershipDialog'
import { buildResearchNavigation } from './research-navigation-model'

vi.mock('react-i18next', () => createI18nTestStub())
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const makeSession = (id: string, extra: Partial<ChatSession> = {}): ChatSession => ({
  id,
  projectId: 'project',
  title: id,
  cwd: '/project',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
  messages: [],
  ...extra
})
const source = makeSession('Research A', { importedResearch: { importId: 'import-a' } })
const discussion = makeSession('Existing conversation', { revision: 7 })
const research = buildResearchNavigation([source]).research
const originalApi = window.api
const originalUpsert = useSessionStore.getState().upsertPersistedSession
const setResearchMembership = vi.fn()
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
const button = (label: string): HTMLButtonElement => {
  const target = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (element) => element.textContent === label
  )
  if (!target) throw new Error(`Missing button: ${label}`)
  return target
}
const render = async (onClose = vi.fn()): Promise<ReturnType<typeof vi.fn>> => {
  await act(async () =>
    root.render(
      <ResearchMembershipDialog session={discussion} research={research} onClose={onClose} />
    )
  )
  return onClose
}

beforeEach(() => {
  setResearchMembership.mockReset()
  window.api = {
    ...originalApi,
    sessionReplay: { ...originalApi?.sessionReplay, setResearchMembership }
  } as never
  useSessionStore.setState({
    sessions: [discussion, source],
    upsertPersistedSession: originalUpsert
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.api = originalApi
  vi.restoreAllMocks()
  useSessionStore.setState({ upsertPersistedSession: originalUpsert })
})

describe('explicit research membership chooser', () => {
  it('does not infer a source or assign until the user selects and confirms one', async () => {
    const onClose = await render()
    expect(button('Assign to research').disabled).toBe(true)
    await act(async () => button('Cancel').click())
    expect(onClose).toHaveBeenCalledOnce()
    expect(setResearchMembership).not.toHaveBeenCalled()
  })

  it('submits the chosen local source with the reviewed revision and applies the main receipt', async () => {
    const persisted = { ...discussion, revision: 8, researchMembership: research[0].source }
    setResearchMembership.mockResolvedValue(persisted)
    const upsert = vi.spyOn(useSessionStore.getState(), 'upsertPersistedSession')
    const onClose = await render()
    await act(async () => button('Research A').click())
    await act(async () => button('Assign to research').click())
    expect(setResearchMembership).toHaveBeenCalledExactlyOnceWith({
      projectId: 'project',
      sessionId: 'Existing conversation',
      expectedRevision: 7,
      source: { projectId: 'project', sourceSessionId: 'Research A', importId: 'import-a' }
    })
    expect(upsert).toHaveBeenCalledWith(persisted)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('keeps the chooser open on revision rejection without changing local ownership', async () => {
    setResearchMembership.mockRejectedValue(new Error('Revision conflict'))
    const upsert = vi.spyOn(useSessionStore.getState(), 'upsertPersistedSession')
    const onClose = await render()
    await act(async () => button('Research A').click())
    await act(async () => button('Assign to research').click())
    expect(document.body.textContent).toContain(
      'Could not update research ownership. Close this dialog and try again.'
    )
    expect(upsert).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})
