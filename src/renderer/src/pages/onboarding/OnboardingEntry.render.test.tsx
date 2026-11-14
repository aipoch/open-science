// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OnboardingWizard } from './OnboardingWizard'
import { readyClaudeState, resetOnboardingStores, stubWindowApi } from './onboarding-test-utils'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  resetOnboardingStores()
  stubWindowApi()
  readyClaudeState()
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
  vi.useRealTimers()
})

const renderEntry = async (): Promise<void> => {
  await act(async () => {
    root.render(<OnboardingWizard showWelcome />)
  })
}

const finishWelcomeAnimation = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
  const fallback = container.querySelector<HTMLElement>('.onboarding-ring-convergence')
  expect(fallback).not.toBeNull()
  await act(async () => {
    if (fallback) fireEvent.animationEnd(fallback, { animationName: 'onboarding-ring-gather' })
    vi.advanceTimersByTime(3_600)
  })
}

describe('Onboarding entry flow', () => {
  it('keeps the welcome action hidden until the animation completes, then opens quick connect', async () => {
    await renderEntry()

    expect(container.querySelector('[data-onboarding-entry="welcome"]')).not.toBeNull()
    expect(container.querySelector('button[data-onboarding-action="next"]')).toBeNull()

    await finishWelcomeAnimation()

    expect(container.querySelector('button[data-onboarding-action="next"]')).not.toBeNull()

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-onboarding-action="next"]')?.click()
    })

    expect(container.querySelector('[data-onboarding-entry="connect"]')).not.toBeNull()
    expect(container.textContent).toContain('Bring the AI you already use.')
    expect(container.textContent).toContain('Advanced options')
  })

  it('keeps the existing five-step wizard behind Advanced options', async () => {
    await renderEntry()
    await finishWelcomeAnimation()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-onboarding-action="next"]')?.click()
    })

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[data-onboarding-action="advanced"]')
        ?.click()
    })

    expect(container.querySelector('[data-onboarding-layout="split"]')).not.toBeNull()
    expect(container.textContent).toContain('Where should Open-Science store your data?')
  })
})
