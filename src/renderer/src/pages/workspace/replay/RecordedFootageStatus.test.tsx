// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { browserPayloadFixture } from './BrowserRecording.test-support'
import { RecordedFootageStatus } from './RecordedFootageStatus'

afterEach(cleanup)
it('distinguishes source time before footage and seeks to the actual first decoded segment', () => {
  const { recording } = browserPayloadFixture()
  const onSeek = vi.fn()
  const onShowNotebook = vi.fn()
  render(
    <RecordedFootageStatus
      recording={recording}
      recordedAt={recording.startedAt - 1}
      onSeek={onSeek}
      onShowNotebook={onShowNotebook}
    />
  )
  expect(screen.getByText('The project recording has not started yet.')).toBeTruthy()
  fireEvent.click(screen.getByText('Jump to recorded footage'))
  expect(onSeek).toHaveBeenCalledWith(recording.startedAt + recording.segments[0].startMs)
  fireEvent.click(screen.getByText('Notebook'))
  expect(onShowNotebook).toHaveBeenCalledOnce()
})
it('does not invent footage after the recording ends or offer a restart action', () => {
  const { recording } = browserPayloadFixture()
  render(
    <RecordedFootageStatus
      recording={recording}
      recordedAt={recording.startedAt + recording.durationMs + 1}
      onSeek={vi.fn()}
      onShowNotebook={vi.fn()}
    />
  )
  expect(screen.getByText('The project recording has ended.')).toBeTruthy()
  expect(screen.queryByText('Jump to recorded footage')).toBeNull()
})
it('keeps unknown timing distinct from known gaps', () => {
  const { recording } = browserPayloadFixture()
  const { container } = render(
    <RecordedFootageStatus recording={recording} onSeek={vi.fn()} onShowNotebook={vi.fn()} />
  )
  expect(container.textContent).toBe('')
})
