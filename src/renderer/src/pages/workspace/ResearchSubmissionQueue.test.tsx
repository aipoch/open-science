// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18nTestStub } from '../../../../../test/i18n-test-stub'
import type { ResearchSubmission } from '../../../../shared/research-submission'
import {
  ResearchSubmissionQueue,
  type ResearchSubmissionQueueController
} from './ResearchSubmissionQueue'
vi.mock('react-i18next', () => createI18nTestStub())
afterEach(cleanup)
const item = (state: ResearchSubmission['state']): ResearchSubmission => ({
  id: 'question',
  sequence: 1,
  projectId: 'project',
  sourceSessionId: 'source',
  messageId: 'user-message',
  state,
  createdAt: 1,
  payload: {
    text: 'Why did this experiment fail?',
    annotations: [],
    attachments: [
      {
        id: 'file',
        versionId: 'version',
        name: 'evidence.txt',
        originalName: 'evidence.txt',
        sessionId: 'intent',
        path: 'upload-version://version',
        size: 8
      }
    ],
    permissionProfile: 'ask',
    agentConfiguration: { providerId: 'codex', reasoningEffort: 'default' },
    forcedSkillIds: []
  }
})
const controller = (state: ResearchSubmission['state']): ResearchSubmissionQueueController => ({
  items: [item(state)],
  retry: vi.fn(async () => undefined),
  cancel: vi.fn(async () => undefined),
  restore: vi.fn(async () => true)
})
describe('saved research question recovery', () => {
  it('shows the queued question and exact attachment without offering a second send', () => {
    const state = controller('queued')
    render(<ResearchSubmissionQueue controller={state} />)
    expect(screen.getByText('Why did this experiment fail?')).toBeTruthy()
    expect(screen.getByText('evidence.txt')).toBeTruthy()
    expect(screen.getByText('Waiting to send')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sending' }))
    expect(state.cancel).toHaveBeenCalledWith('question')
    expect(state.retry).not.toHaveBeenCalled()
  })
  it('requires verification for an uncertain send and never exposes retry', () => {
    const state = controller('uncertain')
    render(<ResearchSubmissionQueue controller={state} />)
    expect(
      screen.getByText(
        'Check the Discussion before sending again. This question will not be retried automatically.'
      )
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(state.retry).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Restore question to draft' }))
    expect(state.restore).toHaveBeenCalledWith('question')
  })
  it('reports a conflicting current draft while retaining the saved question', async () => {
    const state = controller('failed')
    vi.mocked(state.restore).mockResolvedValue(false)
    render(<ResearchSubmissionQueue controller={state} />)
    fireEvent.click(screen.getByRole('button', { name: 'Restore question to draft' }))
    await screen.findByText(
      'The saved question is safe. Clear the current draft before restoring it.'
    )
    expect(screen.getByText('Why did this experiment fail?')).toBeTruthy()
    expect(state.retry).not.toHaveBeenCalled()
  })
  it('allows one explicit retry for confirmed failed admission', async () => {
    const state = controller('failed')
    render(<ResearchSubmissionQueue controller={state} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(state.retry).toHaveBeenCalledExactlyOnceWith('question'))
  })
  it('does not retain an accepted question in the pending surface', () => {
    render(<ResearchSubmissionQueue controller={controller('accepted')} />)
    expect(screen.queryByLabelText('Saved research questions')).toBeNull()
  })
})
