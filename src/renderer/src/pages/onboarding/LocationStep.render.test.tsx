// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSettingsStore } from '@/stores/settings-store'
import { LocationStep } from './LocationStep'
import {
  clickButton,
  DEFAULT_DATA_ROOT,
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
  setIsRelaunching: ReturnType<typeof vi.fn>
}

// The wizard shell fetches the storage info up front and owns the relaunch flag; the step is
// mounted directly with both as props/spies.
const renderStep = async (): Promise<RenderResult> => {
  const onBack = vi.fn()
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
        locationDraft={locationDraft}
        onLocationDraftChange={setLocationDraft}
        relaunchError={relaunchError}
        onRelaunchErrorChange={setRelaunchError}
        onBack={onBack}
        setIsRelaunching={setIsRelaunching}
      />
    )
  }
  await act(async () => {
    root.render(<Harness />)
  })
  return { onBack, setIsRelaunching }
}

describe('LocationStep', () => {
  it('returns to the notebook step from the Back button', async () => {
    const { onBack } = await renderStep()

    await clickButton(/back/i)

    expect(onBack).toHaveBeenCalledOnce()
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

  it('Finish with the default location kept completes onboarding without relaunching', async () => {
    await renderStep()
    await clickButton(/finish/i)

    expect(useSettingsStore.getState().completeOnboarding).toHaveBeenCalledTimes(1)
    expect(window.api.storage.setDataRootAndRelaunch).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('Finish with a chosen non-default path shows a restart confirm dialog', async () => {
    window.api.storage.pickDirectory = vi.fn().mockResolvedValue('/mnt/data')
    window.api.storage.inspectDataRoot = vi
      .fn()
      .mockResolvedValue({ kind: 'move', dataRoot: '/mnt/data/OpenScience' })
    await renderStep()
    await clickButton(/browse/i)
    await clickButton(/finish/i)

    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull()
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
    await clickButton(/finish/i)
    await clickButton(/^restart$/i)

    expect(window.api.storage.setDataRootAndRelaunch).toHaveBeenCalledWith('/mnt/data', true)
    // The shell's full-screen "Setting up" state replaces the wizard while the call is in flight.
    expect(setIsRelaunching).toHaveBeenCalledWith(true)
    // The renderer-side gate must not flip before the main-process relaunch step: only main marks
    // onboarding complete now, inside set-data-root-and-relaunch, so this must never be called.
    expect(useSettingsStore.getState().completeOnboarding).not.toHaveBeenCalled()
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
    await clickButton(/finish/i)
    await clickButton(/^restart$/i)

    // Never marked complete (main only marks it on success), and the gate was never flipped, so
    // the wizard - not Home - is still what's rendered, with the error visible on Location.
    expect(useSettingsStore.getState().completeOnboarding).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Disk is full.')
    expect(container.querySelector('section[aria-label="Choose data location"]')).not.toBeNull()
    expect(setIsRelaunching).toHaveBeenLastCalledWith(false)
  })

  it('Keep default in the confirm dialog completes onboarding without relaunching', async () => {
    window.api.storage.pickDirectory = vi.fn().mockResolvedValue('/mnt/data')
    window.api.storage.inspectDataRoot = vi
      .fn()
      .mockResolvedValue({ kind: 'move', dataRoot: '/mnt/data/OpenScience' })
    await renderStep()
    await clickButton(/browse/i)
    await clickButton(/finish/i)
    await clickButton(/keep default/i)

    expect(useSettingsStore.getState().completeOnboarding).toHaveBeenCalledTimes(1)
    expect(window.api.storage.setDataRootAndRelaunch).not.toHaveBeenCalled()
  })
})
