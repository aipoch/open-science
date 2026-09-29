// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createI18nTestStub } from '../../../../../test/i18n-test-stub'
import { ResearchDraftRecovery } from './ResearchDraftRecovery'
import type { ResearchDraft } from '../../../../shared/research-draft'
vi.mock('react-i18next', () => createI18nTestStub())
afterEach(cleanup)
const savedDraft: ResearchDraft = {
  projectId: 'project',
  sourceSessionId: 'source',
  id: 'draft',
  editorId: 'other-window',
  revision: 1,
  state: 'active',
  updatedAt: 1,
  payload: {
    doc: { nodes: [{ type: 'text', text: 'Saved unsent question' }] },
    annotations: [],
    attachments: [],
    transfers: [],
    automaticReadingEnabled: true,
    editRevision: 1,
    intentId: 'intent'
  }
}
it('leaves restored drafts explicit and prevents duplicate restore/discard actions while awaiting storage', async () => {
  let finish!: () => void
  const restore = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const discard = vi.fn(async () => undefined)
  const refresh = vi.fn()
  render(
    <ResearchDraftRecovery
      drafts={[savedDraft]}
      saving={false}
      onRestore={restore}
      onDiscard={discard}
      onRefresh={refresh}
    />
  )
  expect(restore).not.toHaveBeenCalled()
  const restoreButton = screen.getByRole('button', { name: 'Restore draft', hidden: true })
  const discardButton = screen.getByRole('button', { name: 'Discard draft', hidden: true })
  fireEvent.click(restoreButton)
  fireEvent.click(restoreButton)
  fireEvent.click(discardButton)
  expect(restore).toHaveBeenCalledTimes(1)
  expect(discard).not.toHaveBeenCalled()
  expect((restoreButton as HTMLButtonElement).disabled).toBe(true)
  await act(async () => finish())
  expect((restoreButton as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Check for saved drafts' }))
  expect(refresh).toHaveBeenCalledOnce()
})
