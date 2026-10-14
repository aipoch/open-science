// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RuntimeStartupGate } from './runtime-startup-gate'
import type { RuntimeStartupState } from '../../../shared/runtime-startup'
let root: Root, container: HTMLDivElement
let state: RuntimeStartupState
let emit: (state: RuntimeStartupState) => void
const stop = vi.fn(),
  recover = vi.fn(),
  quit = vi.fn()
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  state = {
    phase: 'blocked',
    issue: {
      reason: 'version-mismatch',
      desktopVersion: '2',
      runtimeVersion: '1',
      canStop: true,
      canRecover: false
    }
  }
  stop.mockReset().mockImplementation(async () => state)
  recover.mockReset().mockImplementation(async () => state)
  quit.mockReset()
  window.api = {
    runtimeStartup: {
      getState: async () => state,
      onStateChanged: (listener: (state: RuntimeStartupState) => void) => {
        emit = listener
        return () => {}
      },
      stopAndContinue: stop,
      recover,
      quit
    }
  } as unknown as typeof window.api
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
const render = async (): Promise<void> => {
  await act(async () =>
    root.render(
      <RuntimeStartupGate>
        <div data-testid="workspace" />
      </RuntimeStartupGate>
    )
  )
}
const click = async (label: string): Promise<void> => {
  await act(async () =>
    [...document.querySelectorAll('button')].find((b) => b.textContent === label)!.click()
  )
}
it('requires confirmation before authenticated startup stop', async () => {
  await render()
  expect(document.querySelector('[data-testid="workspace"]')).toBeNull()
  await click('Continue')
  expect(stop).not.toHaveBeenCalled()
  expect(
    document.querySelector('[data-testid="runtime-startup-confirmation-S17"]')?.textContent
  ).toContain('Unsaved work may be lost')
  await click('Continue')
  expect(stop).toHaveBeenCalledOnce()
})
it('offers only Quit for legacy hosts', async () => {
  state = {
    phase: 'blocked',
    issue: { reason: 'legacy-host', desktopVersion: '2', canStop: false, canRecover: false }
  }
  await render()
  expect(document.body.textContent).not.toContain('Continue')
  expect(document.body.textContent).not.toContain('Stop service')
  expect(document.querySelector('[data-testid="workspace"]')).toBeNull()
})
it('keeps startup blocked until authoritative readiness', async () => {
  await render()
  await act(async () =>
    emit({
      phase: 'stopping',
      issue: { reason: 'version-mismatch', desktopVersion: '2', canStop: true, canRecover: false }
    })
  )
  expect(document.querySelector('[data-testid="workspace"]')).toBeNull()
  expect(document.body.textContent).toContain('Stopping the service…')
  expect(document.body.textContent).not.toContain('Service version mismatch')
  expect(
    [...document.querySelectorAll('button')]
      .filter((b) => b.textContent !== 'Save diagnostics')
      .map((b) => b.textContent)
  ).toEqual([])
  for (const b of document.querySelectorAll('button'))
    if (b.textContent !== 'Save diagnostics') expect(b.disabled).toBe(true)
  await act(async () => emit({ phase: 'ready' }))
  expect(document.querySelector('[data-testid="workspace"]')).not.toBeNull()
})
it('retains the original issue after a failed recovery', async () => {
  state = {
    phase: 'blocked',
    issue: {
      reason: 'startup-recovery-required',
      desktopVersion: '2',
      canStop: false,
      canRecover: true
    }
  }
  recover.mockRejectedValueOnce(new Error('offline'))
  await render()
  await click('Retry')
  expect(document.body.textContent).toContain('The previous session')
  expect(document.body.textContent).toContain('The app could not be checked')
  expect(
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Retry')?.disabled
  ).toBe(false)
})

it('does not mount backend-dependent children before startup hydration', async () => {
  let resolve!: (state: RuntimeStartupState) => void
  window.api.runtimeStartup!.getState = () =>
    new Promise((done) => {
      resolve = done
    })
  await render()
  expect(document.querySelector('[data-testid="workspace"]')).toBeNull()
  await act(async () => resolve({ phase: 'idle' }))
  expect(document.querySelector('[data-testid="workspace"]')).not.toBeNull()
})

it('keeps recheck available without stopping a legacy service', async () => {
  state = {
    phase: 'blocked',
    issue: {
      reason: 'legacy-service',
      desktopVersion: '2',
      runtimeVersion: '1',
      canStop: true,
      canRecover: true
    }
  }
  await render()
  expect(document.body.textContent).not.toContain('restart the computer')
  expect(document.body.textContent).toContain('Continue')
  expect(document.body.textContent).not.toContain('Check and reopen app')
  await click('Retry')
  expect(recover).toHaveBeenCalledOnce()
  expect(stop).not.toHaveBeenCalled()
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  expect(document.querySelector('[data-testid="workspace"]')).toBeNull()
  recover.mockResolvedValueOnce({ phase: 'ready' })
  await click('Retry')
  expect(document.querySelector('[data-testid="workspace"]')).not.toBeNull()
})

it('allows cancelling and retrying a failed legacy shutdown without leaving the upgrade page', async () => {
  state = {
    phase: 'blocked',
    issue: {
      reason: 'legacy-service',
      desktopVersion: '2',
      runtimeVersion: '1',
      canStop: true,
      canRecover: true
    }
  }
  await render()
  await click('Continue')
  expect(
    document.querySelector('[data-testid="runtime-startup-confirmation-S17"]')?.textContent
  ).toContain('custom command-line options will not be kept')
  await click('Cancel')
  expect(stop).not.toHaveBeenCalled()
  stop.mockRejectedValueOnce(new Error('temporarily unavailable'))
  await click('Continue')
  await click('Continue')
  expect(document.body.textContent).toContain('The service could not be stopped or checked')
  expect(document.body.textContent).not.toContain('Check and reopen app')
  stop.mockResolvedValueOnce({ phase: 'ready' })
  await click('Continue')
  await click('Continue')
  expect(stop).toHaveBeenCalledTimes(2)
  expect(document.querySelector('[data-testid="workspace"]')).not.toBeNull()
})

it('allows retrying startup status retrieval without directing users to nonexistent steps', async () => {
  window.api.runtimeStartup!.getState = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ phase: 'ready' })
  await render()
  expect(document.body.textContent).toContain('The app could not be checked. Try again.')
  expect(document.body.textContent).not.toContain('steps below')
  await click('Retry')
  expect(document.querySelector('[data-testid="workspace"]')).not.toBeNull()
})

it('offers an available retry when stopping is unsupported', async () => {
  state = {
    phase: 'blocked',
    issue: {
      reason: 'version-mismatch',
      desktopVersion: '2',
      runtimeVersion: '1',
      canStop: false,
      canRecover: true
    }
  }
  await render()
  await click('Retry')
  expect(recover).toHaveBeenCalledOnce()
  expect(stop).not.toHaveBeenCalled()
  expect(document.querySelector('[data-testid="runtime-startup-confirmation-S17"]')).toBeNull()
})
