// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LocationStep } from './LocationStep'
import {
  clickButton,
  DEFAULT_DATA_ROOT,
  findButton,
  resetOnboardingStores,
  storageInfo,
  stubWindowApi
} from './onboarding-test-utils'

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

type RenderResult = {
  onBack: ReturnType<typeof vi.fn>
  onContinue: ReturnType<typeof vi.fn>
  setIsRelaunching: ReturnType<typeof vi.fn>
}

// The wizard shell fetches the storage info up front and owns the relaunch flag; the step is
// mounted directly with both as props/spies.
const renderStep = async (isResolvingDefaultLocation = false): Promise<RenderResult> => {
  const onBack = vi.fn()
  const onContinue = vi.fn()
  const setIsRelaunching = vi.fn()
  const Harness = (): React.JSX.Element => {
    const [locationDraft, setLocationDraft] = useState({
      chosenParent: '',
      chosenDataRoot: '',
      chosenKind: null as 'move' | 'adopt' | null
    })
    const [relaunchError, setRelaunchError] = useState<string | undefined>(undefined)

    return (
      <LocationStep
        dataRootInfo={storageInfo()}
        dataRootError={undefined}
        locationDraft={locationDraft}
        onLocationDraftChange={setLocationDraft}
        relaunchError={relaunchError}
        onRelaunchErrorChange={setRelaunchError}
        onRetryDataRootInfo={vi.fn()}
        onInteractionStart={vi.fn()}
        onBack={onBack}
        onContinue={onContinue}
        isResolvingDefaultLocation={isResolvingDefaultLocation}
        setIsRelaunching={setIsRelaunching}
      />
    )
  }
  await act(async () => {
    root.render(<Harness />)
  })
  return { onBack, onContinue, setIsRelaunching }
}

describe('LocationStep', () => {
  it('stacks the data path and Browse control on narrow screens', async () => {
    await renderStep()

    const controls = container.querySelector('[aria-label="Data location path"]')?.parentElement
    expect(controls?.className).toContain('flex-col')
    expect(controls?.className).toContain('sm:flex-row')
  })

  it('returns to the environment step from the Back button', async () => {
    const { onBack } = await renderStep()

    await clickButton(/back/i)

    expect(onBack).toHaveBeenCalledOnce()
  })

  it('keeps navigation available while resolving the optional Windows default', async () => {
    await renderStep(true)

    expect(findButton(/^continue$/i)?.disabled).toBe(false)
    expect(findButton(/back/i)?.disabled).toBe(false)
    expect(findButton(/browse/i)?.disabled).toBe(false)
  })

  it('shows the default location passed in from the wizard shell', async () => {
    await renderStep()

    expect(container.textContent).toContain(DEFAULT_DATA_ROOT)
  })

  it('shows the warning callout', async () => {
    await renderStep()

    expect(container.textContent).toContain('Open Science manages this folder')
    expect(container.textContent).toContain(
      "Don't move, rename, or delete files inside it — doing so can break your projects and history."
    )
  })

  it('Browse with a valid path shows the final path and the restart note', async () => {
    window.api.storage.pickDirectory = vi.fn().mockResolvedValue('/mnt/data')
    window.api.storage.inspectDataRoot = vi
      .fn()
      .mockResolvedValue({ kind: 'move', dataRoot: '/mnt/data/OpenScience' })
    await renderStep()
    await clickButton(/browse/i)

    expect(window.api.storage.inspectDataRoot).toHaveBeenCalledWith('/mnt/data')
    expect(container.textContent).toContain('/mnt/data/OpenScience')
    expect(container.textContent).toContain('Open Science will restart to set this up')
  })

  it('Browse with an adopt path shows the used-as-is note', async () => {
    window.api.storage.pickDirectory = vi.fn().mockResolvedValue('/mnt/existing')
    window.api.storage.inspectDataRoot = vi
      .fn()
      .mockResolvedValue({ kind: 'adopt', dataRoot: '/mnt/existing/OpenScience' })
    await renderStep()
    await clickButton(/browse/i)

    expect(container.textContent).toContain('/mnt/existing/OpenScience')
    expect(container.textContent).toContain('already contains Open Science data')
    expect(container.textContent).toContain('used as-is')
  })

  it('Browse with an invalid path shows the inline error and does not set the field', async () => {
    window.api.storage.pickDirectory = vi.fn().mockResolvedValue('/mnt/bad')
    window.api.storage.inspectDataRoot = vi.fn().mockResolvedValue({
      kind: 'invalid',
      dataRoot: '/mnt/bad/OpenScience',
      error: 'The selected folder is not writable.'
    })
    await renderStep()
    await clickButton(/browse/i)

    expect(container.textContent).toContain('The selected folder is not writable.')
    expect(container.textContent).not.toContain('/mnt/bad/OpenScience')
  })

  it('Browse cancelled (null) leaves the default location untouched', async () => {
    window.api.storage.pickDirectory = vi.fn().mockResolvedValue(null)
    await renderStep()
    await clickButton(/browse/i)

    expect(window.api.storage.inspectDataRoot).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('restart to set this up')
  })

  it('starts only one directory picker while the first request is pending', async () => {
    window.api.storage.pickDirectory = vi.fn().mockReturnValue(new Promise(() => undefined))
    await renderStep()

    const browseButton = findButton(/browse/i)
    await act(async () => {
      browseButton?.click()
      browseButton?.click()
      await Promise.resolve()
    })

    expect(window.api.storage.pickDirectory).toHaveBeenCalledTimes(1)
    expect(browseButton?.disabled).toBe(true)
    expect(findButton(/back/i)?.disabled).toBe(true)
    expect(findButton(/continue/i)?.disabled).toBe(true)
  })

  it('shows an inline error when browsing for a location rejects', async () => {
    window.api.storage.pickDirectory = vi
      .fn()
      .mockRejectedValue(new Error('Directory picker failed.'))
    await renderStep()

    await clickButton(/browse/i)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Directory picker failed.'
    )
  })

  it('shows an inline error when inspecting a selected location rejects', async () => {
    window.api.storage.pickDirectory = vi.fn().mockResolvedValue('/mnt/data')
    window.api.storage.inspectDataRoot = vi
      .fn()
      .mockRejectedValue(new Error('Directory inspection failed.'))
    await renderStep()

    await clickButton(/browse/i)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Directory inspection failed.'
    )
    expect(container.textContent).not.toContain('/mnt/data/OpenScience')
  })

  it('"Use default location" clears a previously chosen path', async () => {
    window.api.storage.pickDirectory = vi.fn().mockResolvedValue('/mnt/data')
    window.api.storage.inspectDataRoot = vi
      .fn()
      .mockResolvedValue({ kind: 'move', dataRoot: '/mnt/data/OpenScience' })
    await renderStep()
    await clickButton(/browse/i)
    expect(container.textContent).toContain('/mnt/data/OpenScience')

    await clickButton(/use default location/i)

    expect(container.textContent).not.toContain('restart to set this up')
  })

  it('Continue with the default location advances without relaunching', async () => {
    const { onContinue } = await renderStep()
    await clickButton(/continue/i)

    expect(onContinue).toHaveBeenCalledOnce()
    expect(window.api.storage.setDataRootAndRelaunch).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('Continue with a chosen non-default path shows a restart confirm dialog', async () => {
    window.api.storage.pickDirectory = vi.fn().mockResolvedValue('/mnt/data')
    window.api.storage.inspectDataRoot = vi
      .fn()
      .mockResolvedValue({ kind: 'move', dataRoot: '/mnt/data/OpenScience' })
    await renderStep()
    await clickButton(/browse/i)
    await clickButton(/continue/i)

    const overlay = Array.from(document.body.querySelectorAll<HTMLElement>('div')).find((element) =>
      element.className.includes('bg-black/50')
    )
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')

    expect(dialog).not.toBeNull()
    expect(overlay?.className).toContain('data-[state=open]:fade-in-0')
    expect(overlay?.className).toContain('data-[state=closed]:fill-mode-forwards')
    expect(overlay?.className).not.toContain('backdrop-blur')
    expect(dialog?.className).toContain('rounded-xl')
    expect(dialog?.className).toContain('border-border')
    expect(dialog?.className).toContain('bg-card')
    expect(dialog?.className).toContain('shadow-dialog')
    expect(dialog?.className).toContain('data-[state=open]:zoom-in-95')
    expect(dialog?.className).toContain('p-0')
    expect(
      Array.from(dialog?.querySelectorAll<HTMLElement>('div') ?? []).some((element) =>
        element.className.includes('border-b border-border-300/90')
      )
    ).toBe(true)
    expect(
      Array.from(dialog?.querySelectorAll<HTMLElement>('div') ?? []).some((element) =>
        element.className.includes('border-t border-border-300/90')
      )
    ).toBe(true)
    expect(dialog?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')).not.toBeNull()
    expect(document.body.textContent).toContain('/mnt/data/OpenScience')
    // The dialog gates the relaunch; nothing has happened yet.
    expect(window.api.storage.setDataRootAndRelaunch).not.toHaveBeenCalled()
  })

  it('Restart in the confirm dialog calls setDataRootAndRelaunch without flipping the renderer gate', async () => {
    window.api.storage.pickDirectory = vi.fn().mockResolvedValue('/mnt/data')
    window.api.storage.inspectDataRoot = vi
      .fn()
      .mockResolvedValue({ kind: 'move', dataRoot: '/mnt/data/OpenScience' })
    window.api.storage.setDataRootAndRelaunch = vi.fn().mockResolvedValue({ ok: true })
    const { setIsRelaunching } = await renderStep()
    await clickButton(/browse/i)
    await clickButton(/continue/i)
    await clickButton(/^restart$/i)

    expect(window.api.storage.setDataRootAndRelaunch).toHaveBeenCalledWith('/mnt/data', false)
    // The shell's full-screen "Setting up" state replaces the wizard while the call is in flight.
    expect(setIsRelaunching).toHaveBeenCalledWith(true)
    // Storage is applied before the remaining onboarding steps, so the main-process command must
    // persist only dataRoot and leave onboarding incomplete across the relaunch.
  })

  it('starts only one confirmed relaunch while the first request is pending', async () => {
    window.api.storage.pickDirectory = vi.fn().mockResolvedValue('/mnt/data')
    window.api.storage.inspectDataRoot = vi
      .fn()
      .mockResolvedValue({ kind: 'move', dataRoot: '/mnt/data/OpenScience' })
    window.api.storage.setDataRootAndRelaunch = vi
      .fn()
      .mockReturnValue(new Promise(() => undefined))
    await renderStep()
    await clickButton(/browse/i)
    await clickButton(/continue/i)

    const restartButton = findButton(/^restart$/i)
    await act(async () => {
      restartButton?.click()
      restartButton?.click()
      await Promise.resolve()
    })

    expect(window.api.storage.setDataRootAndRelaunch).toHaveBeenCalledTimes(1)
  })

  it('a setDataRootAndRelaunch failure shows the inline error and resets the relaunch flag', async () => {
    window.api.storage.pickDirectory = vi.fn().mockResolvedValue('/mnt/data')
    window.api.storage.inspectDataRoot = vi
      .fn()
      .mockResolvedValue({ kind: 'move', dataRoot: '/mnt/data/OpenScience' })
    window.api.storage.setDataRootAndRelaunch = vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'Disk is full.' })
    const { setIsRelaunching } = await renderStep()
    await clickButton(/browse/i)
    await clickButton(/continue/i)
    await clickButton(/^restart$/i)

    // The pointer was not committed, so the wizard remains on Location with the error visible.
    expect(container.textContent).toContain('Disk is full.')
    expect(container.querySelector('section[aria-label="Choose data location"]')).not.toBeNull()
    expect(setIsRelaunching).toHaveBeenLastCalledWith(false)
  })

  it('a rejected setDataRootAndRelaunch call shows the inline error and resets the relaunch flag', async () => {
    window.api.storage.pickDirectory = vi.fn().mockResolvedValue('/mnt/data')
    window.api.storage.inspectDataRoot = vi
      .fn()
      .mockResolvedValue({ kind: 'move', dataRoot: '/mnt/data/OpenScience' })
    window.api.storage.setDataRootAndRelaunch = vi
      .fn()
      .mockRejectedValue(new Error('Relaunch IPC failed.'))
    const { setIsRelaunching } = await renderStep()
    await clickButton(/browse/i)
    await clickButton(/continue/i)
    await clickButton(/^restart$/i)

    expect(container.textContent).toContain('Relaunch IPC failed.')
    expect(container.querySelector('section[aria-label="Choose data location"]')).not.toBeNull()
    expect(setIsRelaunching).toHaveBeenLastCalledWith(false)
  })

  it('Keep default in the confirm dialog advances without relaunching', async () => {
    window.api.storage.pickDirectory = vi.fn().mockResolvedValue('/mnt/data')
    window.api.storage.inspectDataRoot = vi
      .fn()
      .mockResolvedValue({ kind: 'move', dataRoot: '/mnt/data/OpenScience' })
    const { onContinue } = await renderStep()
    await clickButton(/browse/i)
    await clickButton(/continue/i)
    await clickButton(/keep default/i)

    expect(onContinue).toHaveBeenCalledOnce()
    expect(window.api.storage.setDataRootAndRelaunch).not.toHaveBeenCalled()
  })

  it('closing the confirm dialog keeps the chosen path without advancing', async () => {
    window.api.storage.pickDirectory = vi.fn().mockResolvedValue('/mnt/data')
    window.api.storage.inspectDataRoot = vi
      .fn()
      .mockResolvedValue({ kind: 'move', dataRoot: '/mnt/data/OpenScience' })
    const { onContinue } = await renderStep()
    await clickButton(/browse/i)
    await clickButton(/continue/i)

    const closeButton = document.body.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
    expect(closeButton).not.toBeNull()
    await act(async () => {
      closeButton?.click()
    })

    expect(onContinue).not.toHaveBeenCalled()
    expect(window.api.storage.setDataRootAndRelaunch).not.toHaveBeenCalled()
    expect(container.textContent).toContain('/mnt/data/OpenScience')
  })

  it('pressing Escape keeps the chosen path without advancing', async () => {
    window.api.storage.pickDirectory = vi.fn().mockResolvedValue('/mnt/data')
    window.api.storage.inspectDataRoot = vi
      .fn()
      .mockResolvedValue({ kind: 'move', dataRoot: '/mnt/data/OpenScience' })
    const { onContinue } = await renderStep()
    await clickButton(/browse/i)
    await clickButton(/continue/i)

    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(onContinue).not.toHaveBeenCalled()
    expect(window.api.storage.setDataRootAndRelaunch).not.toHaveBeenCalled()
    expect(container.textContent).toContain('/mnt/data/OpenScience')
  })
})
