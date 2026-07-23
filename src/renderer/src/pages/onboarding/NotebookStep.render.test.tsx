// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useNotebookEnvStore } from '@/stores/notebook-env-store'
import { useSettingsStore } from '@/stores/settings-store'
import { NotebookStep } from './NotebookStep'
import { environment, resetOnboardingStores, stubWindowApi } from './onboarding-test-utils'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  resetOnboardingStores()
  stubWindowApi()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
})

const renderStep = async (
  onBack: () => void = vi.fn(),
  onContinue: () => void = vi.fn()
): Promise<void> => {
  await act(async () => {
    root.render(<NotebookStep onBack={onBack} onContinue={onContinue} />)
  })
  // Flush the RuntimesPanel discovery/enablement microtasks so its runtime cards render.
  await act(async () => {})
  await act(async () => {})
}

const continueButton = (): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === 'Continue'
  ) as HTMLButtonElement | undefined

const backButton = (): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === 'Back'
  ) as HTMLButtonElement | undefined

const provisioningState = (): void => {
  useNotebookEnvStore.setState({
    status: { pythonReady: false, rReady: false, version: 3, provisioning: true },
    scope: 'python',
    progress: { phase: 'materialize', message: 'Preparing Python environment…', progress: 0.3 }
  })
}

describe('NotebookStep', () => {
  it('is optional: Continue is enabled by default and forwards the click', async () => {
    useSettingsStore.setState({ environmentCheck: environment(true) })
    const onContinue = vi.fn()

    await renderStep(vi.fn(), onContinue)

    expect(container.textContent).toContain('Notebook runtime (optional)')
    expect(container.textContent).toContain('Optional — nothing here is required to finish setup.')
    expect(continueButton()?.disabled).toBe(false)

    await act(async () => continueButton()?.click())
    expect(onContinue).toHaveBeenCalledOnce()
  })

  it('returns to the provider step from the Back button', async () => {
    const onBack = vi.fn()

    await renderStep(onBack)

    await act(async () => backButton()?.click())
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('reuses the complete Settings runtimes panel with Python and R logos', async () => {
    await renderStep()

    const panel = container.querySelector('section[aria-label="Notebook runtime (optional)"]')
    expect(panel?.querySelector('h3')?.textContent).toBe('Notebook runtime (optional)')
    expect(panel?.textContent).toContain(
      'Notebooks run in an app-managed Python environment by default. You can change any of this later in Settings → Runtimes.'
    )
    expect(panel?.querySelector('button')?.textContent).toContain('Recheck')
    expect(container.textContent).not.toContain(
      'Enable the environments each notebook language may run in.'
    )
    expect(container.querySelector('[data-testid="runtimes-panel"]')).not.toBeNull()
    expect(container.querySelector('svg[aria-label="Python"]')).not.toBeNull()
    expect(container.querySelector('svg[aria-label="R"]')).not.toBeNull()
    expect(container.querySelector('section[aria-label="Python runtime"]')).not.toBeNull()
    expect(container.querySelector('section[aria-label="R runtime"]')).not.toBeNull()
    expect(container.textContent).toContain('Download and set up')
  })

  it('shows Python setup progress inside the reused app-managed runtime card', async () => {
    provisioningState()
    useNotebookEnvStore.setState({
      byLang: {
        python: {
          preparing: true,
          progress: {
            phase: 'materialize',
            message: 'Preparing Python environment…',
            progress: 0.3,
            language: 'python'
          }
        }
      }
    })
    useSettingsStore.setState({ environmentCheck: environment(true) })

    await renderStep()

    const progress = container.querySelector('[aria-label="Setting up Python runtime"]')
    expect(progress).not.toBeNull()
    expect(progress?.getAttribute('aria-valuenow')).toBe('30')
    expect(container.textContent).toContain('Preparing Python environment')
  })

  it('gates Back and Continue while a runtime setup is in flight, then enables both when idle', async () => {
    // A user-started provision must finish (or be cancelled) before leaving the step — continuing
    // mid-create would strand a half-built env. The button must be DISABLED while provisioning even
    // though nothing on this optional step otherwise blocks continuation.
    provisioningState()
    useSettingsStore.setState({ environmentCheck: environment(true) })
    const onBack = vi.fn()

    await renderStep(onBack)

    expect(continueButton()?.disabled).toBe(true)
    expect(backButton()?.disabled).toBe(true)
    await act(async () => backButton()?.click())
    expect(onBack).not.toHaveBeenCalled()
    // The footer explains why the user can't continue yet.
    expect(container.textContent).toContain('Setting up the notebook runtime')

    // Once the provision settles (idle), the same state re-enables Continue.
    await act(async () => {
      useNotebookEnvStore.setState({
        status: { pythonReady: true, rReady: false, version: 3, provisioning: false }
      })
    })
    await act(async () => {})
    expect(continueButton()?.disabled).toBe(false)
    expect(backButton()?.disabled).toBe(false)
  })

  it('gates navigation as soon as a language starts preparing, before status catches up', async () => {
    useNotebookEnvStore.setState({
      byLang: {
        r: {
          preparing: true,
          progress: undefined,
          error: undefined
        }
      }
    })

    await renderStep()

    expect(useNotebookEnvStore.getState().status.provisioning).toBe(false)
    expect(continueButton()?.disabled).toBe(true)
    expect(backButton()?.disabled).toBe(true)
    expect(container.textContent).toContain('Setting up the notebook runtime')
  })
})
