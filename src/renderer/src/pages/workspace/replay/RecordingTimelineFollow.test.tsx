// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ResearchRecordingCoverage } from '@/lib/replay/recorded-time'
import { RecordingTimelineFollow } from './RecordingTimelineFollow'

afterEach(cleanup)
const target = { projectId: 'p', sessionId: 's', artifactId: 'a', versionId: 'v1' }
const coverage: ResearchRecordingCoverage[] = [
  {
    recordingId: 'r',
    target,
    startedAt: 1000,
    endedAt: 2000,
    ranges: [{ startedAt: 1000, endedAt: 2000 }]
  }
]
it('changes only the selected source, hides stale content during a switch and respects manual selection', () => {
  const onSelect = vi.fn(),
    onFollowingChange = vi.fn()
  const props = {
    enabled: true,
    following: true,
    onSelect,
    onFollowingChange,
    coverage,
    availableTargets: [target],
    recordedAt: 1500
  }
  const view = render(
    <RecordingTimelineFollow {...props}>
      <video data-testid="footage" />
    </RecordingTimelineFollow>
  )
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(target)
  expect(screen.queryByTestId('footage')).toBeNull()
  view.rerender(
    <RecordingTimelineFollow {...props} selected={target}>
      <video data-testid="footage" />
    </RecordingTimelineFollow>
  )
  expect(screen.getByTestId('footage')).toBeTruthy()
  expect(onSelect).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Following replay' }))
  expect(onFollowingChange).toHaveBeenLastCalledWith(false)
  view.rerender(
    <RecordingTimelineFollow {...props} following={false}>
      <video data-testid="footage" />
    </RecordingTimelineFollow>
  )
  expect(screen.getByTestId('footage')).toBeTruthy()
  expect(onSelect).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Follow replay' }))
  expect(onFollowingChange).toHaveBeenLastCalledWith(true)
})
it('does not silently show arbitrary overlapping footage, while manual inspection remains available', () => {
  const props = {
    enabled: true,
    following: true,
    onSelect: vi.fn(),
    onFollowingChange: vi.fn(),
    coverage: [...coverage, { ...coverage[0], target: { ...target, versionId: 'v2' } }],
    recordedAt: 1500,
    selected: target,
    availableTargets: [target]
  }
  const view = render(
    <RecordingTimelineFollow {...props}>
      <video data-testid="footage" />
    </RecordingTimelineFollow>
  )
  expect(
    screen.getByText('Recordings overlap at this time. Choose a recording to view it.')
  ).toBeTruthy()
  expect(screen.queryByTestId('footage')).toBeNull()
  expect(props.onSelect).not.toHaveBeenCalled()
  view.rerender(
    <RecordingTimelineFollow {...props} following={false}>
      <video data-testid="footage" />
    </RecordingTimelineFollow>
  )
  expect(screen.getByTestId('footage')).toBeTruthy()
})
it('discloses unavailable footage without selecting another source or waiting forever', () => {
  const onSelect = vi.fn()
  render(
    <RecordingTimelineFollow
      enabled
      following
      onFollowingChange={vi.fn()}
      coverage={coverage}
      availableTargets={[]}
      recordedAt={1500}
      onSelect={onSelect}
    >
      <video data-testid="footage" />
    </RecordingTimelineFollow>
  )
  expect(screen.getByText('This recorded media file is not included.')).toBeTruthy()
  expect(onSelect).not.toHaveBeenCalled()
  expect(screen.queryByTestId('footage')).toBeNull()
})
