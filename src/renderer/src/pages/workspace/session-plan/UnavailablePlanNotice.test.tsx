// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSession } from '@/stores/session-store'
import { UnavailablePlanNotice } from './UnavailablePlanNotice'

const originalApi = window.api
const discardUnavailablePlan = vi.fn()
const session = {
  id: 'session-1',
  projectId: 'project-1',
  status: 'waiting-plan-approval',
  messages: [],
  runtimeContext: {
    version: 1,
    revision: 4,
    plan: {
      artifactId: 'artifact-1',
      artifactVersionId: 'version-1',
      artifactChecksum: 'a'.repeat(64),
      approval: 'pending',
      stepStatuses: {}
    }
  }
} as unknown as ChatSession
beforeEach(() => {
  discardUnavailablePlan.mockReset().mockResolvedValue({ revision: 5 })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { acp: { discardUnavailablePlan } }
  })
})
afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'api', { configurable: true, value: originalApi })
})

describe('unavailable Plan recovery confirmation', () => {
  it('requires confirmation, retains the reviewed identity, and prevents duplicate submission', async () => {
    const view = render(<UnavailablePlanNotice session={session} />)
    fireEvent.click(screen.getByRole('button', { name: 'Discard unavailable Plan' }))
    expect(discardUnavailablePlan).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog').textContent).toContain(
      'Messages and Artifacts are kept.'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(discardUnavailablePlan).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Discard unavailable Plan' }))
    // A stale confirmation must not silently switch to a newer Plan.
    view.rerender(
      <UnavailablePlanNotice
        session={{
          ...session,
          runtimeContext: {
            ...session.runtimeContext!,
            revision: 8,
            plan: { ...session.runtimeContext!.plan!, artifactVersionId: 'version-2' }
          }
        }}
      />
    )
    let resolve!: (value: { revision: number }) => void
    discardUnavailablePlan.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    const confirm = within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Discard unavailable Plan'
    })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(discardUnavailablePlan).toHaveBeenCalledTimes(1)
    expect(discardUnavailablePlan).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: 'version-1',
      expectedRevision: 4
    })
    await act(async () => {
      resolve({ revision: 5 })
    })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Discard unavailable Plan' }).hasAttribute('disabled')
    ).toBe(true)
  })

  it('keeps a failed discard visible and allows a new explicit confirmation', async () => {
    discardUnavailablePlan.mockRejectedValueOnce(
      new Error('The Plan revision changed concurrently.')
    )
    render(<UnavailablePlanNotice session={session} />)
    fireEvent.click(screen.getByRole('button', { name: 'Discard unavailable Plan' }))
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('alertdialog')).getByRole('button', {
          name: 'Discard unavailable Plan'
        })
      )
    })
    expect(screen.getByText('The Plan revision changed concurrently.')).toBeTruthy()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Discard unavailable Plan' }))
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(discardUnavailablePlan).toHaveBeenCalledTimes(1)
  })
})
