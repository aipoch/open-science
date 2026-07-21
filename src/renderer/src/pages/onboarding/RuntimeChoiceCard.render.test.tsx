// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Radix Select calls pointer-capture and scroll APIs jsdom does not implement.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = (): void => undefined
}

import type { DiscoveredInterpreter } from '../../../../shared/notebook-runtime'
import { useNotebookEnvStore } from '@/stores/notebook-env-store'
import { RuntimeChoiceCard } from './RuntimeChoiceCard'

let container: HTMLDivElement
let root: Root

// Two detected pythons: the app-managed default (runnable) and one the user already had on PATH.
const pythonEnvs: DiscoveredInterpreter[] = [
  {
    language: 'python',
    provenance: 'app-managed',
    envId: '/data/runtime/envs/default-python/bin/python',
    interpreterPath: '/data/runtime/envs/default-python/bin/python',
    label: 'App-managed Python',
    version: '3.12.4',
    runnable: true
  },
  {
    language: 'python',
    provenance: 'user-own',
    envId: '/usr/local/bin/python3',
    interpreterPath: '/usr/local/bin/python3',
    label: 'Homebrew Python',
    version: '3.11.9',
    runnable: true
  }
]

let listEnvironments: ReturnType<typeof vi.fn>
let getEnablement: ReturnType<typeof vi.fn>
let setEnvironmentEnabled: ReturnType<typeof vi.fn>
let registerInterpreter: ReturnType<typeof vi.fn>
let pickInterpreter: ReturnType<typeof vi.fn>

beforeEach(() => {
  listEnvironments = vi.fn().mockResolvedValue({ python: pythonEnvs, r: [] })
  getEnablement = vi.fn().mockResolvedValue({ enabled: {}, installAuthorized: {} })
  setEnvironmentEnabled = vi.fn().mockImplementation(async (_lang: string, envId: string) => ({
    enabled: { [envId]: true },
    installAuthorized: {}
  }))
  registerInterpreter = vi.fn().mockResolvedValue(['/opt/python/bin/python3'])
  pickInterpreter = vi.fn().mockResolvedValue('/opt/python/bin/python3')
  ;(window as unknown as { api: unknown }).api = {
    runtime: {
      listEnvironments,
      getEnablement,
      setEnvironmentEnabled,
      registerInterpreter,
      pickInterpreter
    }
  }
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

const render = async (): Promise<void> => {
  await act(async () => {
    root.render(<RuntimeChoiceCard />)
  })
  // Flush the listEnvironments + getEnablement microtasks.
  await act(async () => {})
  await act(async () => {})
}

const openInterpreterMenu = async (): Promise<void> => {
  const trigger = document.body.querySelector<HTMLButtonElement>(
    '[aria-label="Use my own Python interpreter"]'
  )
  await act(async () => {
    trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    trigger?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
    trigger?.click()
  })
}

const clickOption = async (matcher: RegExp): Promise<void> => {
  const item = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (el) => matcher.test(el.textContent ?? '')
  )
  await act(async () => {
    item?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    item?.click()
  })
  await act(async () => {})
}

const findButton = (matcher: RegExp): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((el) =>
    matcher.test(el.textContent ?? '')
  )

describe('RuntimeChoiceCard', () => {
  it('shows the managed Python default and offers detected interpreters, no BYO for R', async () => {
    await render()
    const text = container.textContent ?? ''
    expect(text).toContain('Notebook runtime')
    expect(text).toContain('App-managed environment')
    expect(text).toContain('Ready')
    expect(text).toContain('R runs in the app-managed environment')
    // The interpreter control is a dropdown (no raw file dialog for the common case).
    const trigger = document.body.querySelector('[aria-label="Use my own Python interpreter"]')
    expect(trigger).not.toBeNull()
    // It never file-picks on its own — discovery drives the options.
    expect(listEnvironments).toHaveBeenCalledOnce()
    expect(pickInterpreter).not.toHaveBeenCalled()
  })

  it('enables a detected interpreter picked from the dropdown', async () => {
    await render()
    await openInterpreterMenu()
    await clickOption(/Homebrew Python/i)

    expect(setEnvironmentEnabled).toHaveBeenCalledWith('python', '/usr/local/bin/python3', true)
    expect(pickInterpreter).not.toHaveBeenCalled()
    // The enabled interpreter is reflected back in the card.
    expect(container.textContent).toContain('Homebrew Python')
  })

  it('falls back to Browse… for an interpreter not auto-detected', async () => {
    await render()
    await openInterpreterMenu()
    await clickOption(/Browse for an interpreter/i)

    expect(pickInterpreter).toHaveBeenCalledOnce()
    expect(registerInterpreter).toHaveBeenCalledWith('python', '/opt/python/bin/python3')
    expect(setEnvironmentEnabled).toHaveBeenCalledWith('python', '/opt/python/bin/python3', true)
  })

  it('Browse enables a symlinked pick by its discovered realpath envId, not the raw picked path', async () => {
    // The picker returns the symlink the user chose; discovery re-keys the env by its realpath.
    const symlinkPath = '/usr/local/bin/python3'
    const realPath = '/opt/python/3.12/bin/python3'
    pickInterpreter.mockResolvedValue(symlinkPath)
    // After registering, discovery surfaces the env under its realpath envId while echoing the
    // symlink as the interpreterPath — so matching by path finds it, but the enablement key differs.
    listEnvironments.mockResolvedValue({
      python: [
        pythonEnvs[0],
        {
          language: 'python',
          provenance: 'user-own',
          envId: realPath,
          interpreterPath: symlinkPath,
          label: 'Symlinked Python',
          version: '3.12.4',
          runnable: true
        }
      ],
      r: []
    })

    await render()
    await openInterpreterMenu()
    await clickOption(/Browse for an interpreter/i)

    expect(registerInterpreter).toHaveBeenCalledWith('python', symlinkPath)
    // Enabled by the realpath envId, never by the raw symlink path the picker returned.
    expect(setEnvironmentEnabled).toHaveBeenCalledWith('python', realPath, true)
    expect(setEnvironmentEnabled).not.toHaveBeenCalledWith('python', symlinkPath, true)
  })

  it('keeps Cancel clickable during a real in-flight managed provision', async () => {
    // No runnable app-managed env → the "Download and set up" affordance is shown.
    listEnvironments.mockResolvedValue({ python: [], r: [] })

    // Replace the store actions with a provision that never settles on its own, so the card stays in
    // its `starting` state and the button flips to a live Cancel wired to the store's cancel.
    const store = useNotebookEnvStore.getState()
    const originalProvision = store.provision
    const originalCancel = store.cancel
    let resolveProvision: (() => void) | undefined
    const provisionMock = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveProvision = resolve
        })
    )
    const cancelMock = vi.fn().mockResolvedValue(undefined)
    useNotebookEnvStore.setState({ provision: provisionMock, cancel: cancelMock })

    try {
      await render()

      const download = findButton(/Download and set up/i)
      expect(download).toBeDefined()
      await act(async () => {
        download?.click()
      })
      await act(async () => {})

      expect(provisionMock).toHaveBeenCalledWith('python')
      const cancel = findButton(/Cancel/i)
      expect(cancel).toBeDefined()
      expect(cancel?.disabled).toBe(false)

      await act(async () => {
        cancel?.click()
      })
      await act(async () => {})

      expect(cancelMock).toHaveBeenCalledWith('python')
    } finally {
      // Settle the dangling provision and restore the real store actions.
      resolveProvision?.()
      await act(async () => {})
      useNotebookEnvStore.setState({ provision: originalProvision, cancel: originalCancel })
    }
  })
})
