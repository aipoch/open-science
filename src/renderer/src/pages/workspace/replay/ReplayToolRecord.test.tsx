// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { PersistedToolActivity } from '../../../../../shared/session-persistence'
import { ReplayToolRecord } from './ReplayToolRecord'

afterEach(cleanup)
const activity: PersistedToolActivity = {
  id: 'tool',
  kind: 'tool',
  title: 'Run archived analysis',
  status: 'failed',
  sortIndex: 0,
  eventIds: [],
  createdAt: 0,
  updatedAt: 1000,
  rawInput: { command: 'analyze saved-data.csv' },
  terminalOutput: 'terminal channel',
  rawOutput: { reason: 'result channel' },
  toolContent: [{ type: 'text', text: 'content channel' }],
  terminalExitCode: 7,
  toolDisposition: 'declined',
  elicitation: {
    message: 'Which archived dataset?',
    state: 'answered',
    fields: [{ id: 'dataset', kind: 'text', label: 'Dataset' }],
    answers: [{ fieldId: 'dataset', value: 'saved-data.csv' }]
  }
}
describe('read-only saved tool interactions', () => {
  it('shows each saved output channel, confirmation answer, decision and exit code after the result boundary', () => {
    const { container, rerender } = render(
      <ReplayToolRecord activity={activity} showResults={false} />
    )
    expect(screen.getByText(/Which archived dataset/u)).toBeTruthy()
    expect(container.textContent).not.toContain('terminal channel')
    expect(container.textContent).not.toContain('Request declined')
    expect(screen.queryByText('Recorded answers')).toBeNull()
    rerender(<ReplayToolRecord activity={activity} showResults />)
    expect(container.querySelectorAll('[data-replay-output-channel]')).toHaveLength(3)
    for (const text of [
      'terminal channel',
      'result channel',
      'content channel',
      'Recorded answers',
      'Request declined',
      'Exit code'
    ])
      expect(container.textContent).toContain(text)
    expect(container.textContent).toContain('7')
    expect(container.querySelectorAll('button,input,select')).toHaveLength(0)
  })
  it('bounds large archived payloads and explicitly offers the full original record', () => {
    const { container } = render(
      <ReplayToolRecord
        activity={{
          ...activity,
          rawInput: 'oversized input '.repeat(100000),
          terminalOutput: 'oversized output '.repeat(100000)
        }}
        showResults
      />
    )
    expect(container.textContent!.length).toBeLessThan(40000)
    expect(
      screen.getAllByText('Preview is truncated. Open the evidence for the complete record.')
    ).toHaveLength(2)
  })
})
