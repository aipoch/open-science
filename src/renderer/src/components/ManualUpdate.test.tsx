// @vitest-environment jsdom
import { act } from 'react'
import { useManualUpdate } from './use-manual-update'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ManualUpdateFailure, ManualUpdateGuide, ManualUpdateLinks } from './ManualUpdate'
import { useUpdateStore } from '@/stores/update-store'
import type { UpdateInstaller, UpdateStatus } from '../../../shared/update'
import { APP } from '../../../shared/app-config'

let root: Root, container: HTMLDivElement
const originalStore = useUpdateStore.getState()
const originalApi = window.api
const ready: UpdateStatus = {
  state: 'ready',
  current: '1',
  latest: '2',
  localPath: '/confirmed/update.zip'
}
const fixture = (
  installer: UpdateInstaller | null
): {
  getInstaller: ReturnType<typeof vi.fn<() => Promise<UpdateInstaller | null>>>
  revealInstaller: ReturnType<typeof vi.fn<() => Promise<'revealed'>>>
} => {
  const getInstaller = vi.fn(async () => installer)
  const revealInstaller = vi.fn(async () => 'revealed' as const)
  window.api = {
    platform: 'darwin',
    update: { getInstaller, revealInstaller }
  } as unknown as typeof window.api
  return { getInstaller, revealInstaller }
}
const View = (): React.JSX.Element => {
  const manual = useManualUpdate(true)
  const status = useUpdateStore((state) => state.status)
  return manual.guideOpen ? (
    <ManualUpdateGuide manual={manual} status={status} />
  ) : (
    <>
      <ManualUpdateFailure manual={manual} status={status} />
      <ManualUpdateLinks manual={manual} />
    </>
  )
}
const button = (text: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((node) => node.textContent === text)
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  useUpdateStore.setState({ status: ready })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.api = originalApi
  useUpdateStore.setState(originalStore)
})

it.each([
  ['zip', 'darwin', 'Unzip the file.', 'For a website download (DMG)'],
  ['dmg', 'darwin', 'Open the DMG.', 'Download another installer'],
  ['exe', 'win32', 'keep the existing installation folder', 'Download another installer'],
  ['deb', 'linux', 'system’s software installer', 'Download another installer'],
  ['appimage', 'linux', 'Allow it to run as a program', 'Download another installer'],
  ['unknown', 'linux', 'Follow the instructions for your package', 'Download another installer']
] as const)(
  'uses the confirmed %s format and leaves a usable path after quitting',
  async (format, platform, step, alternative) => {
    const api = fixture({ format, platform, fileName: `actual-package.${format}` })
    await act(async () => root.render(<View />))
    await act(async () => button('Installation instructions')!.click())
    expect(container.textContent).toContain(`actual-package.${format}`)
    expect(container.textContent).toContain('Keep the installer folder open when you quit.')
    expect(container.textContent).toContain(step)
    expect(container.textContent).toContain('Check the version in Settings')
    expect(container.querySelector('summary')?.textContent).toBe(alternative)
    const back = container.querySelector<HTMLButtonElement>('[aria-label="Back to update"]')!
    expect(document.activeElement).toBe(back)
    await act(async () => back.click())
    expect(document.activeElement).toBe(button('Installation instructions'))
    expect(api.revealInstaller).not.toHaveBeenCalled()
    expect(useUpdateStore.getState().status).toBe(ready)
  }
)

it('rejects a stale inspection after the target changes', async () => {
  let resolve!: (value: UpdateInstaller | null) => void
  const api = fixture(null)
  api.getInstaller.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  await act(async () => root.render(<View />))
  await act(async () =>
    useUpdateStore.setState({ status: { ...ready, latest: '3', localPath: undefined } })
  )
  await act(async () => resolve({ fileName: 'old.zip', platform: 'darwin', format: 'zip' }))
  expect(button('Show in Finder')).toBeUndefined()
  expect(container.textContent).not.toContain('old.zip')
  await act(async () => button('Installation instructions')!.click())
  expect(container.textContent).toContain('Choose the installer for your computer.')
  expect(container.querySelector('a')?.href).toBe(APP.update.downloadPage)
})

it('reports missing files without claiming installation and drops the reveal action', async () => {
  fixture({ fileName: 'package.zip', platform: 'darwin', format: 'zip' })
  window.api.update.revealInstaller = vi.fn(async () => 'missing' as const)
  await act(async () => root.render(<View />))
  await act(async () => button('Show in Finder')!.click())
  expect(button('Show in Finder')).toBeUndefined()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'Download the update again'
  )
  expect(useUpdateStore.getState().status).toBe(ready)
})

it('ignores a late reveal response when the same release has a new confirmed file', async () => {
  const api = fixture({ fileName: 'first.zip', platform: 'darwin', format: 'zip' })
  let finish!: (value: 'unavailable') => void
  window.api.update.revealInstaller = vi.fn(
    () =>
      new Promise<'unavailable'>((resolve) => {
        finish = resolve
      })
  )
  await act(async () => root.render(<View />))
  act(() => button('Show in Finder')!.click())
  api.getInstaller.mockResolvedValue({ fileName: 'second.zip', platform: 'darwin', format: 'zip' })
  await act(async () =>
    useUpdateStore.setState({ status: { ...ready, localPath: '/confirmed/second.zip' } })
  )
  await act(async () => finish('unavailable'))
  expect(button('Show in Finder')).toBeDefined()
  expect(container.querySelector('[role="alert"]')).toBeNull()
  await act(async () => button('Installation instructions')!.click())
  expect(container.textContent).toContain('second.zip')
  expect(container.textContent).not.toContain('first.zip')
})

it('shows main-confirmed missing-file feedback without overwriting a recovery failure', async () => {
  fixture(null)
  const status: UpdateStatus = {
    ...ready,
    installerMissing: true,
    error: 'Original recovery error'
  }
  useUpdateStore.setState({ status })
  await act(async () => root.render(<View />))
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'Download the update again'
  )
  expect(useUpdateStore.getState().status.error).toBe('Original recovery error')
})

it('distinguishes preparation feedback and unknown installation while explaining manual steps', async () => {
  fixture(null)
  const recovery = {
    phase: 'preparing',
    runtime: 'running',
    installation: 'unchanged',
    canCancel: true,
    canRecover: false,
    canRetryInstall: false
  } as const
  useUpdateStore.setState({
    status: { ...ready, reason: 'install-failed', error: 'Save failed', recovery }
  })
  await act(async () => root.render(<View />))
  expect(container.textContent).toContain('Save your work before updating manually.')
  expect(container.textContent).not.toContain('may still be running')
  await act(async () =>
    useUpdateStore.setState({
      status: {
        ...ready,
        reason: 'install-failed',
        recovery: { ...recovery, installation: 'unknown' }
      }
    })
  )
  expect(container.textContent).not.toContain('Save your work before updating manually.')
  await act(async () => button('Installation instructions')!.click())
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    'An installer may still be running. Wait before installing manually.'
  )
  expect(container.querySelectorAll('button')).toHaveLength(1)
})
