// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ElicitationResponse } from '../../../../shared/acp'
import type { DelegatedQuestionRequest } from '../../../../shared/session-persistence'
import { WorkspaceDelegatedQuestionCard } from './WorkspaceDelegatedQuestionCard'

const request: DelegatedQuestionRequest = {
  requestId: 'question-request',
  canonicalDigest: 'a'.repeat(64),
  sourceFrameId: 'child-frame',
  sourceAttemptId: 'source-attempt',
  sourceRuntimeSegmentId: 'source-runtime',
  sourceMessageBranchId: 'child-branch',
  rootOriginMessageId: 'root-prompt',
  rootBranchId: 'root-branch',
  sourceName: 'Source audit',
  questions: [
    { question: 'Which cohort?', options: [{ label: 'Strict' }, { label: 'Broad' }] },
    { question: 'Which window?', options: [{ label: '30 days' }, { label: '90 days' }] }
  ],
  sequence: 1,
  askedAt: 10,
  status: 'pending',
  draftAnswers: [],
  draftQuestionIndex: 0
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('WorkspaceDelegatedQuestionCard', () => {
  it('defaults legacy questions to single select and updates the chip when advancing to multi select', async () => {
    render(
      <WorkspaceDelegatedQuestionCard
        projectId="project-1"
        sessionId="session-1"
        request={{
          ...request,
          questions: [request.questions[0], { ...request.questions[1], kind: 'multi-select' }]
        }}
        onRespond={async () => undefined}
      />
    )
    expect(screen.getByTestId('choice-kind-chip').textContent).toBe('Single select')
    fireEvent.click(screen.getByRole('button', { name: 'Strict' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByTestId('choice-kind-chip').textContent).toBe('Multi select')
    fireEvent.click(screen.getByRole('button', { name: '30 days' }))
    fireEvent.click(screen.getByRole('button', { name: '90 days' }))
    expect(screen.getByRole('button', { name: '30 days' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    expect(screen.getByRole('button', { name: '90 days' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
  })

  it('toggles all 16 choices, restores drafts and submits an ordered array', async () => {
    const onRespond = vi.fn<(response: ElicitationResponse) => Promise<void>>(async () => undefined)
    const labels = Array.from({ length: 16 }, (_, i) => `Option ${i + 1}`)
    render(
      <WorkspaceDelegatedQuestionCard
        projectId="project-1"
        sessionId="session-1"
        request={{
          ...request,
          questions: [
            {
              question: 'Which outputs?',
              kind: 'multi-select',
              options: labels.map((label) => ({ label }))
            }
          ],
          draftAnswers: [{ questionIndex: 0, value: [labels[0]] }]
        }}
        onRespond={onRespond}
      />
    )
    expect(screen.getByRole('button', { name: labels[0] }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    fireEvent.click(screen.getByRole('button', { name: labels[15] }))
    fireEvent.click(screen.getByRole('button', { name: labels[1] }))
    fireEvent.click(screen.getByRole('button', { name: labels[0] }))
    fireEvent.blur(screen.getByRole('textbox', { name: 'Type your own answer' }))
    expect(screen.getByRole('button', { name: labels[15] }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }))
    await waitFor(() =>
      expect(onRespond).toHaveBeenCalledWith(
        expect.objectContaining({
          delegatedQuestion: expect.objectContaining({
            action: 'confirm',
            answers: [{ questionIndex: 0, value: [labels[1], labels[15]] }]
          })
        })
      )
    )
  })

  it('treats custom and agent-decide answers as alternatives to multiple choices', async () => {
    const onRespond = vi.fn<(response: ElicitationResponse) => Promise<void>>(async () => undefined)
    render(
      <WorkspaceDelegatedQuestionCard
        projectId="project-1"
        sessionId="session-1"
        request={{ ...request, questions: [{ ...request.questions[0], kind: 'multi-select' }] }}
        onRespond={onRespond}
      />
    )
    const strict = screen.getByRole('button', { name: 'Strict' })
    fireEvent.click(strict)
    fireEvent.click(strict)
    expect(screen.queryByRole('button', { name: 'Finish' })).toBeNull()
    fireEvent.click(strict)
    fireEvent.change(screen.getByRole('textbox', { name: 'Type your own answer' }), {
      target: { value: 'Custom' }
    })
    expect(strict.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(strict)
    expect(
      (screen.getByRole('textbox', { name: 'Type your own answer' }) as HTMLTextAreaElement).value
    ).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Let the agent decide' }))
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }))
    await waitFor(() =>
      expect(onRespond).toHaveBeenCalledWith(
        expect.objectContaining({
          delegatedQuestion: expect.objectContaining({
            action: 'confirm',
            answers: [{ questionIndex: 0, value: 'Let the agent decide' }]
          })
        })
      )
    )
  })

  it('persists only the latest custom answer after rapid typing', async () => {
    vi.useFakeTimers()
    const onRespond = vi.fn<(response: ElicitationResponse) => Promise<void>>(async () => undefined)
    render(
      <WorkspaceDelegatedQuestionCard
        projectId="project-1"
        sessionId="session-1"
        request={{ ...request, questions: request.questions.slice(0, 1) }}
        onRespond={onRespond}
      />
    )

    const input = screen.getByRole('textbox', { name: 'Type your own answer' })
    fireEvent.change(input, { target: { value: 'f' } })
    fireEvent.change(input, { target: { value: 'fi' } })
    fireEvent.change(input, { target: { value: 'final' } })

    await act(() => vi.advanceTimersByTimeAsync(300))

    expect(onRespond).toHaveBeenCalledTimes(1)
    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({
        delegatedQuestion: expect.objectContaining({
          action: 'draft',
          answers: [{ questionIndex: 0, value: 'final' }]
        })
      })
    )
  })

  it('persists the latest custom answer immediately on blur', async () => {
    vi.useFakeTimers()
    const onRespond = vi.fn<(response: ElicitationResponse) => Promise<void>>(async () => undefined)
    render(
      <WorkspaceDelegatedQuestionCard
        projectId="project-1"
        sessionId="session-1"
        request={{ ...request, questions: request.questions.slice(0, 1) }}
        onRespond={onRespond}
      />
    )

    const input = screen.getByRole('textbox', { name: 'Type your own answer' })
    fireEvent.change(input, { target: { value: 'final' } })
    fireEvent.blur(input)
    await act(async () => Promise.resolve())

    expect(onRespond).toHaveBeenCalledTimes(1)
    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({
        delegatedQuestion: expect.objectContaining({
          action: 'draft',
          answers: [{ questionIndex: 0, value: 'final' }]
        })
      })
    )
  })

  it('persists the latest custom answer when the card unmounts during the debounce window', async () => {
    vi.useFakeTimers()
    const onRespond = vi.fn<(response: ElicitationResponse) => Promise<void>>(async () => undefined)
    const { unmount } = render(
      <WorkspaceDelegatedQuestionCard
        projectId="project-1"
        sessionId="session-1"
        request={{ ...request, questions: request.questions.slice(0, 1) }}
        onRespond={onRespond}
      />
    )

    fireEvent.change(screen.getByRole('textbox', { name: 'Type your own answer' }), {
      target: { value: 'final' }
    })
    unmount()
    await act(async () => Promise.resolve())

    expect(onRespond).toHaveBeenCalledTimes(1)
    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({
        delegatedQuestion: expect.objectContaining({
          action: 'draft',
          answers: [{ questionIndex: 0, value: 'final' }]
        })
      })
    )
  })

  it('finishes with the latest answer without waiting for an in-flight draft', async () => {
    vi.useFakeTimers()
    let releaseDraft: (() => void) | undefined
    const onRespond = vi.fn<(response: ElicitationResponse) => Promise<void>>((response) =>
      response.delegatedQuestion?.action === 'draft'
        ? new Promise<void>((resolve) => {
            releaseDraft = resolve
          })
        : Promise.resolve()
    )
    render(
      <WorkspaceDelegatedQuestionCard
        projectId="project-1"
        sessionId="session-1"
        request={{ ...request, questions: request.questions.slice(0, 1) }}
        onRespond={onRespond}
      />
    )

    const input = screen.getByRole('textbox', { name: 'Type your own answer' })
    fireEvent.change(input, { target: { value: 'first' } })
    await act(() => vi.advanceTimersByTimeAsync(300))
    expect(onRespond).toHaveBeenCalledTimes(1)

    fireEvent.change(input, { target: { value: 'final' } })
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }))
    await act(async () => Promise.resolve())

    expect(onRespond).toHaveBeenCalledTimes(2)
    expect(onRespond).toHaveBeenLastCalledWith(
      expect.objectContaining({
        delegatedQuestion: expect.objectContaining({
          action: 'confirm',
          answers: [{ questionIndex: 0, value: 'final' }]
        })
      })
    )
    releaseDraft?.()
  })

  it('replaces drafts that have not started with the latest answer', async () => {
    vi.useFakeTimers()
    let releaseFirstDraft: (() => void) | undefined
    let isFirstDraft = true
    const onRespond = vi.fn<(response: ElicitationResponse) => Promise<void>>(() => {
      if (!isFirstDraft) return Promise.resolve()
      isFirstDraft = false
      return new Promise<void>((resolve) => {
        releaseFirstDraft = resolve
      })
    })
    render(
      <WorkspaceDelegatedQuestionCard
        projectId="project-1"
        sessionId="session-1"
        request={{ ...request, questions: request.questions.slice(0, 1) }}
        onRespond={onRespond}
      />
    )

    const input = screen.getByRole('textbox', { name: 'Type your own answer' })
    fireEvent.change(input, { target: { value: 'first' } })
    await act(() => vi.advanceTimersByTimeAsync(300))
    expect(onRespond).toHaveBeenCalledTimes(1)

    fireEvent.change(input, { target: { value: 'obsolete' } })
    await act(() => vi.advanceTimersByTimeAsync(300))
    fireEvent.change(input, { target: { value: 'final' } })
    await act(() => vi.advanceTimersByTimeAsync(300))
    expect(onRespond).toHaveBeenCalledTimes(1)

    await act(async () => {
      releaseFirstDraft?.()
      await Promise.resolve()
    })

    expect(onRespond).toHaveBeenCalledTimes(2)
    expect(onRespond).toHaveBeenLastCalledWith(
      expect.objectContaining({
        delegatedQuestion: expect.objectContaining({
          action: 'draft',
          answers: [{ questionIndex: 0, value: 'final' }]
        })
      })
    )
  })

  it('serializes durable drafts before later navigation writes', async () => {
    let releaseFirstDraft: (() => void) | undefined
    const onRespond = vi.fn<(response: ElicitationResponse) => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          releaseFirstDraft ??= resolve
        })
    )
    render(
      <WorkspaceDelegatedQuestionCard
        projectId="project-1"
        sessionId="session-1"
        request={request}
        onRespond={onRespond}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Strict' }))
    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(onRespond).toHaveBeenCalledTimes(1)

    releaseFirstDraft?.()
    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(2))
    expect(onRespond).toHaveBeenLastCalledWith(
      expect.objectContaining({
        delegatedQuestion: expect.objectContaining({ action: 'draft', questionIndex: 1 })
      })
    )
  })

  it('finishes a single-question request without a review or confirmation page', async () => {
    const onRespond = vi.fn<(response: ElicitationResponse) => Promise<void>>(async () => undefined)
    render(
      <WorkspaceDelegatedQuestionCard
        projectId="project-1"
        sessionId="session-1"
        request={{ ...request, questions: request.questions.slice(0, 1) }}
        onRespond={onRespond}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Strict' }))
    expect(screen.queryByText('Review answers')).toBeNull()
    expect(screen.queryByRole('button', { name: /Confirm & send/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }))

    await waitFor(() =>
      expect(onRespond).toHaveBeenLastCalledWith(
        expect.objectContaining({
          requestId: 'question-request',
          delegatedQuestion: expect.objectContaining({
            action: 'confirm',
            answers: [{ questionIndex: 0, value: 'Strict' }]
          })
        })
      )
    )
  })

  it('keeps Next and Back as drafts, then finishes the multi-question request once', async () => {
    const onRespond = vi.fn<(response: ElicitationResponse) => Promise<void>>(async () => undefined)
    render(
      <WorkspaceDelegatedQuestionCard
        projectId="project-1"
        sessionId="session-1"
        request={request}
        onRespond={onRespond}
      />
    )

    expect(screen.getByText('Asked by Source audit')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Strict' }))
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    fireEvent.click(screen.getByRole('button', { name: '90 days' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Broad' }))
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))

    expect(
      onRespond.mock.calls.every(([response]) => response.delegatedQuestion?.action === 'draft')
    ).toBe(true)
    expect(screen.queryByText('Review answers')).toBeNull()
    expect(screen.queryByRole('button', { name: /Confirm & send/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }))
    await waitFor(() =>
      expect(onRespond).toHaveBeenLastCalledWith(
        expect.objectContaining({
          requestId: 'question-request',
          delegatedQuestion: expect.objectContaining({
            action: 'confirm',
            answers: [
              { questionIndex: 0, value: 'Broad' },
              { questionIndex: 1, value: '90 days' }
            ]
          })
        })
      )
    )
  })
})
