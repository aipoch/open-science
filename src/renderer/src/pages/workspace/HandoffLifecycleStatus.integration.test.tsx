// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  HandoffLifecycleEvent,
  HandoffLifecycleEventSource
} from '../../../../shared/handoff-lifecycle'

import { projectHandoffLifecycle } from './handoff-lifecycle-projection'
import { HandoffLifecycleStatus } from './HandoffLifecycleStatus'
import { useHandoffLifecycleEvents } from './useHandoffLifecycleEvents'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class FakeCoordinatorStream implements HandoffLifecycleEventSource {
  private eventsBySession = new Map<string, readonly HandoffLifecycleEvent[]>()
  private listeners = new Set<() => void>()

  getEvents(sessionId: string): readonly HandoffLifecycleEvent[] {
    return this.eventsBySession.get(sessionId) ?? EMPTY_EVENTS
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: HandoffLifecycleEvent): void {
    this.eventsBySession.set(event.sessionId, [...this.getEvents(event.sessionId), event])
    this.listeners.forEach((listener) => listener())
  }
}

const EMPTY_EVENTS: readonly HandoffLifecycleEvent[] = []

const statusEvent = (
  phase: HandoffLifecycleEvent['phase'],
  sequence: number
): HandoffLifecycleEvent => ({
  id: `handoff-${sequence}`,
  sessionId: 'session-1',
  sequence,
  observedAt: 1_710_000_000_000 + sequence,
  phase,
  target: { kind: 'specialist', name: 'Data analyst' },
  provenance: {
    originatingTurnId: 'turn-1',
    originatingUserMessageId: 'user-1',
    attachmentIds: ['upload-1'],
    artifactIds: ['artifact-1']
  }
})

const Transcript = ({ source }: { source: HandoffLifecycleEventSource }): React.JSX.Element => {
  const events = useHandoffLifecycleEvents(source, 'session-1')
  return (
    <>
      <div data-testid="user-turn" data-user-message-id="user-1">
        Analyze the sample
      </div>
      <div data-testid="pre-handoff-output">I will inspect the input first.</div>
      {projectHandoffLifecycle(events).map((handoff) => (
        <HandoffLifecycleStatus key={handoff.id} handoff={handoff} />
      ))}
      <div data-testid="continuation-output">Continuing with the approved specialist.</div>
    </>
  )
}

describe('same-turn handoff transcript', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('projects a fake coordinator lifecycle through one original user turn without duplicating output', async () => {
    const source = new FakeCoordinatorStream()

    await act(async () => root.render(<Transcript source={source} />))
    await act(async () => source.emit(statusEvent('awaiting-approval', 1)))

    expect(container.textContent).toContain('Awaiting approval to switch to Data analyst')
    expect(container.querySelectorAll('[data-handoff-lifecycle]').length).toBe(1)

    await act(async () => source.emit(statusEvent('reconfiguring', 2)))
    expect(container.textContent).toContain('Reconfiguring Data analyst')

    await act(async () => source.emit(statusEvent('continuation-start', 3)))
    expect(container.textContent).toContain('Starting continuation with Data analyst')

    await act(async () =>
      source.emit({
        ...statusEvent('continued', 4),
        continuation: {
          outcome: 'returned',
          switchReadback: { target: { kind: 'specialist', name: 'Data analyst' } }
        }
      })
    )

    const lifecycle = container.querySelector<HTMLElement>('[data-handoff-lifecycle]')
    expect(lifecycle?.dataset.originatingUserMessageId).toBe('user-1')
    expect(lifecycle?.dataset.originatingTurnId).toBe('turn-1')
    expect(lifecycle?.textContent).toContain('Continued with Data analyst')
    expect(container.querySelectorAll('[data-testid="user-turn"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-testid="pre-handoff-output"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-testid="continuation-output"]')).toHaveLength(1)
  })

  it('does not regress on a delayed broadcast and presents a failed handoff retry intent', async () => {
    const source = new FakeCoordinatorStream()
    const onRetry = vi.fn(async () => undefined)

    await act(async () => root.render(<Transcript source={source} />))
    await act(async () => source.emit(statusEvent('switching', 2)))
    await act(async () => source.emit(statusEvent('awaiting-approval', 1)))

    expect(container.textContent).toContain('Switching to Data analyst')
    expect(container.textContent).not.toContain('Awaiting approval')

    await act(async () =>
      source.emit({
        ...statusEvent('failed', 3),
        failure: { retryFrom: 'reconfiguring', message: 'The approved target is unavailable.' }
      })
    )

    const lifecycle = container.querySelector<HTMLElement>('[data-handoff-lifecycle]')
    expect(lifecycle?.getAttribute('role')).toBe('alert')
    expect(lifecycle?.textContent).toContain('Could not continue with Data analyst')
    expect(lifecycle?.textContent).toContain('The approved target is unavailable.')
    await act(async () => {
      root.render(
        <HandoffLifecycleStatus
          handoff={projectHandoffLifecycle(source.getEvents('session-1'))[0]!}
          onRetry={onRetry}
        />
      )
    })
    await act(async () => container.querySelector<HTMLButtonElement>('button')?.click())
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('keeps a failed handoff visible when the retry IPC request rejects', async () => {
    const onRetry = vi.fn(async () => Promise.reject(new Error('runtime unavailable')))
    const failed = projectHandoffLifecycle([
      {
        ...statusEvent('failed', 1),
        failure: { retryFrom: 'continuation-start', message: 'Continuation did not start.' }
      }
    ])[0]!
    await act(async () =>
      root.render(<HandoffLifecycleStatus handoff={failed} onRetry={onRetry} />)
    )

    await act(async () => container.querySelector<HTMLButtonElement>('button')?.click())

    expect(container.textContent).toContain('Could not continue with Data analyst')
    expect(container.textContent).toContain('Retry could not start')
    expect(container.textContent).toContain('Retry handoff')
  })
})
