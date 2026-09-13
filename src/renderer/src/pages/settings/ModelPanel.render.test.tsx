// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18next } from '@/i18n'
import type { LocalModelSnapshot } from '../../../../shared/local-models'
import { ModelPanel } from './ModelPanel'

let container: HTMLDivElement
let root: Root
let snapshot: LocalModelSnapshot
const api = {
  getSnapshot: vi.fn(async () => snapshot),
  install: vi.fn(
    async () => (snapshot = { ...snapshot, availability: 'installing', hasFiles: true })
  ),
  cancel: vi.fn(
    async () =>
      (snapshot = {
        ...snapshot,
        availability: snapshot.installedRevision ? 'ready' : 'notInstalled'
      })
  ),
  remove: vi.fn(async () => (snapshot = { ...snapshot, hasFiles: false }))
}
const Harness = ({ initialLocal = true }: { initialLocal?: boolean }): React.JSX.Element => {
  const [local, setLocal] = useState(initialLocal)
  return (
    <ModelPanel local={local} onChange={setLocal}>
      <div data-testid="providers" />
    </ModelPanel>
  )
}
const click = async (label: string): Promise<void> => {
  const button = [...document.querySelectorAll('button')].find(
    (element) => element.textContent === label
  )
  expect(button, label).toBeDefined()
  await act(async () => button!.click())
}
beforeEach(async () => {
  vi.clearAllMocks()
  await i18next.changeLanguage('en')
  snapshot = {
    availability: 'notInstalled',
    recommendedRevision: 'v1',
    downloadBytes: 100,
    installedBytes: 0,
    transferredBytes: 0,
    updateAvailable: false,
    hasFiles: false,
    inUse: false
  }
  vi.stubGlobal('api', { localModels: api })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
describe('model settings A tabs', () => {
  it('prevents removal while in use and updates an already-open confirmation', async () => {
    vi.useFakeTimers()
    snapshot = { ...snapshot, availability: 'ready', installedRevision: 'v1', hasFiles: true }
    await act(async () => root.render(<Harness />))
    await click('Remove model')
    snapshot = { ...snapshot, inUse: true }
    // Remounting is unnecessary: exercise the panel's existing polling subscription.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500)
    })
    expect(container.textContent).toContain(
      'Model in use. Removal is available when parsing finishes.'
    )
    for (const label of ['Remove model', 'Remove']) {
      const button = [...document.querySelectorAll('button')].find(
        (entry) => entry.textContent === label
      )!
      expect(button.disabled).toBe(true)
      await act(async () => button.click())
    }
    expect(api.remove).not.toHaveBeenCalled()
    snapshot = { ...snapshot, inUse: false }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500)
    })
    await click('Remove')
    expect(api.remove).toHaveBeenCalledOnce()
  })
  it('preserves Agent models as the default without requesting local models', async () => {
    await act(async () => root.render(<Harness initialLocal={false} />))
    expect(container.querySelector('[data-testid="providers"]')).not.toBeNull()
    expect(api.getSnapshot).not.toHaveBeenCalled()
    const tab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (element) => element.textContent === 'Local parsing models'
    )!
    await act(async () =>
      tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    )
    expect(await api.getSnapshot.mock.results[0]?.value).toEqual(snapshot)
    expect(container.textContent).toContain('PDF figures and tables')
  })
  it('installs, cancels and removes retained partial files only after confirmation', async () => {
    await act(async () => root.render(<Harness />))
    expect(container.querySelector('details')).toBeNull()
    expect(container.textContent).not.toContain('Model updates')
    expect(container.textContent).not.toContain('Manual update')
    expect(container.textContent).not.toContain('Update available')
    expect([...container.querySelectorAll('dt')].map((entry) => entry.textContent)).toEqual([
      'Version',
      'Download size'
    ])
    await click('Install')
    expect(api.install).toHaveBeenCalledOnce()
    expect(container.querySelector('progress')).not.toBeNull()
    await click('Cancel download')
    expect(api.cancel).toHaveBeenCalledOnce()
    await click('Remove model')
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
    expect(api.remove).not.toHaveBeenCalled()
    await click('Remove')
    expect(api.remove).toHaveBeenCalledOnce()
    expect(container.textContent).not.toContain('Remove model')
  })
  it('offers a compatible update in its card and preserves the installed version on cancellation', async () => {
    snapshot = {
      ...snapshot,
      availability: 'ready',
      installedRevision: 'v0',
      installedBytes: 80,
      hasFiles: true,
      updateAvailable: true
    }
    await act(async () => root.render(<Harness />))
    expect(container.textContent).toContain('Update available')
    expect([...container.querySelectorAll('dt')].map((entry) => entry.textContent)).toEqual([
      'Installed version',
      'Installed size',
      'New version',
      'Download size'
    ])
    expect(api.install).not.toHaveBeenCalled()
    await click('Update')
    expect(api.install).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('The installed version remains available')
    await click('Cancel download')
    expect(container.textContent).toContain('Update available')
    expect(container.textContent).toContain('v0')
    expect(api.remove).not.toHaveBeenCalled()
  })
  it('does not offer an update when the installed version is current', async () => {
    snapshot = { ...snapshot, availability: 'ready', installedRevision: 'v1', hasFiles: true }
    await act(async () => root.render(<Harness />))
    expect(container.textContent).not.toContain('Update available')
    expect(container.textContent).not.toContain('Model updates')
    expect([...container.querySelectorAll('dt')].map((entry) => entry.textContent)).toEqual([
      'Installed version',
      'Installed size'
    ])
    expect(
      [...container.querySelectorAll('dd')].filter((entry) => entry.textContent === 'v1')
    ).toHaveLength(1)
    expect([...container.querySelectorAll('button')].map((button) => button.textContent)).toContain(
      'Remove model'
    )
    expect(
      [...container.querySelectorAll('button')].map((button) => button.textContent)
    ).not.toContain('Update')
    expect(api.install).not.toHaveBeenCalled()
  })
})
