// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UpdateDialog } from './UpdateDialog'
import { useUpdateStore } from '@/stores/update-store'
import { APP } from '../../../shared/app-config'
import type { ManualInstallInfo, UpdateStatus } from '../../../shared/update'

vi.mock('@/components/streamdown/AgentMarkdown', () => ({
  AgentMarkdown: ({ content }: { content: string }) => <div>{content}</div>
}))
const local: ManualInstallInfo = {
  kind: 'local',
  identity: 'artifact-2',
  platform: 'win32',
  arch: 'x64',
  version: '2',
  format: 'nsis',
  fileName: 'setup.exe',
  size: 5000
}
const original = useUpdateStore.getState()
let root: Root, container: HTMLDivElement
let getManualInstall: ReturnType<typeof vi.fn>, revealManualInstaller: ReturnType<typeof vi.fn>
const button = (name: string): HTMLButtonElement =>
  [...document.querySelectorAll('button')].find((node) => node.textContent === name)!
const status = (extra: Partial<UpdateStatus> = {}): UpdateStatus => ({
  state: 'ready',
  current: '1',
  latest: '2',
  applyKind: 'installer',
  error: 'Install failed',
  notes: 'Release notes',
  manualInstall: local,
  ...extra
})
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  getManualInstall = vi.fn(async () => local)
  revealManualInstaller = vi.fn(async () => local)
  vi.stubGlobal('api', undefined)
  window.api = {
    update: { getManualInstall, revealManualInstaller }
  } as unknown as typeof window.api
  useUpdateStore.setState({ ...original, isDialogOpen: true, status: status() })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useUpdateStore.setState(original)
  vi.unstubAllGlobals()
})
const render = (): void => act(() => root.render(<UpdateDialog />))
const enter = async (): Promise<void> => {
  await act(async () => button('Install manually…').click())
}

describe('manual update instructions', () => {
  it.each([false, true])(
    'explains the occupancy prerequisite without installing or quitting (%s)',
    async (runtime) => {
      const conditional = { ...local, requiresQuitAndReleaseOccupancy: true as const }
      const apply = vi.fn(async () => {})
      const cancel = vi.fn(async () => {})
      useUpdateStore.setState({
        apply,
        cancel,
        status: status({
          manualInstall: conditional,
          ...(runtime
            ? {
                reason: 'installation-busy' as const,
                recovery: {
                  phase: 'preparing' as const,
                  runtime: 'running' as const,
                  installation: 'unchanged' as const,
                  detail: 'other-runtime' as const,
                  canCancel: true,
                  canRecover: false,
                  canRetryInstall: false
                }
              }
            : {})
        })
      })
      getManualInstall.mockResolvedValue(conditional)
      revealManualInstaller.mockResolvedValue(conditional)
      render()
      await enter()
      expect(document.body.textContent).toContain('Completely quit Open-Science')
      expect(document.body.textContent).toContain('close other instances or stop services')
      expect(document.body.textContent).toContain('Manual installation does not release files')
      expect(document.body.textContent).toContain('Verified installer')
      expect(document.body.textContent).not.toContain('Ready for manual installation')
      await act(async () => button('Show in File Explorer').click())
      expect(revealManualInstaller).toHaveBeenCalledExactlyOnceWith()
      expect(apply).not.toHaveBeenCalled()
      expect(cancel).not.toHaveBeenCalled()
      act(() => button('Use a new download instead').click())
      expect(document.body.textContent).toContain('Manual installation does not release files')
    }
  )
  it('discards an in-flight unqualified response when the occupancy prerequisite changes', async () => {
    let finish!: (info: ManualInstallInfo) => void
    getManualInstall.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    render()
    act(() => button('Install manually…').click())
    act(() =>
      useUpdateStore.setState({
        status: status({ manualInstall: { ...local, requiresQuitAndReleaseOccupancy: true } })
      })
    )
    await act(async () => finish(local))
    expect(button('Show in File Explorer')).toBeUndefined()
    expect(document.body.textContent).not.toContain('Ready for manual installation')
  })
  it.each(['pending', 'unknown'] as const)(
    'withdraws conditional instructions when main reports native installation %s',
    async (installation) => {
      const conditional = { ...local, requiresQuitAndReleaseOccupancy: true as const }
      useUpdateStore.setState({ status: status({ manualInstall: conditional }) })
      getManualInstall.mockResolvedValue(conditional)
      render()
      await enter()
      act(() =>
        useUpdateStore.setState({
          status: status({
            manualInstall: { ...local, kind: 'blocked' },
            reason: 'install-failed',
            recovery: {
              phase: 'install-check',
              runtime: 'unknown',
              installation,
              canCancel: false,
              canRecover: true,
              canRetryInstall: false
            }
          })
        })
      )
      expect(button('Show in File Explorer')).toBeUndefined()
      expect(button('Install manually…')).toBeUndefined()
      expect(revealManualInstaller).not.toHaveBeenCalled()
    }
  )
  it.each([undefined, { ...local, kind: 'blocked' } as ManualInstallInfo])(
    'requires an explicit main-process grant (%s)',
    (manualInstall) => {
      useUpdateStore.setState({ status: status({ manualInstall }) })
      render()
      expect(button('Install manually…')).toBeUndefined()
      expect(document.querySelector(`a[href="${APP.update.downloadPage}"]`)).toBeNull()
    }
  )
  it('shows complete instructions in the same dialog and only reveals through main', async () => {
    render()
    await enter()
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(document.body.textContent).toContain('setup.exe')
    expect(document.querySelectorAll('ol li')).toHaveLength(3)
    expect(document.body.textContent).toContain('keep the existing installation location')
    expect(document.querySelector(`a[href="${APP.update.downloadPage}"]`)).toBeNull()
    await act(async () => button('Show in File Explorer').click())
    expect(getManualInstall).toHaveBeenCalledExactlyOnceWith()
    expect(revealManualInstaller).toHaveBeenCalledExactlyOnceWith()
    await act(async () => button('Back to update').click())
    expect(document.body.textContent).toContain('Release notes')
  })
  it('coalesces checks and discards an old target result', async () => {
    let finish!: (value: ManualInstallInfo) => void
    getManualInstall.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    render()
    act(() => {
      button('Install manually…').click()
      button('Install manually…').click()
    })
    expect(getManualInstall).toHaveBeenCalledOnce()
    expect(document.body.textContent).toContain('Checking installer…')
    expect(button('Checking installer…').disabled).toBe(true)
    act(() =>
      useUpdateStore.setState({
        status: status({ latest: '3', manualInstall: { ...local, identity: 'artifact-3' } })
      })
    )
    await act(async () => finish(local))
    expect(document.body.textContent).not.toContain('setup.exe')
    expect(button('Install manually…')).toBeDefined()
  })
  it('invalidates a check when the artifact changes without a version change', async () => {
    let finish!: (value: ManualInstallInfo) => void
    getManualInstall.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    render()
    act(() => button('Install manually…').click())
    act(() =>
      useUpdateStore.setState({
        status: status({ manualInstall: { ...local, identity: 'replacement-artifact' } })
      })
    )
    await act(async () => finish(local))
    expect(button('Show in File Explorer')).toBeUndefined()
    expect(document.body.textContent).not.toContain('setup.exe')
  })
  it('hides a manual page when main blocks eligibility and does not restore it after reopening', async () => {
    render()
    await enter()
    act(() =>
      useUpdateStore.setState({ status: status({ manualInstall: { ...local, kind: 'blocked' } }) })
    )
    expect(button('Show in File Explorer')).toBeUndefined()
    act(() => useUpdateStore.setState({ status: status() }))
    expect(button('Show in File Explorer')).toBeUndefined()
    await enter()
    act(() => useUpdateStore.setState({ isDialogOpen: false }))
    act(() => useUpdateStore.setState({ isDialogOpen: true }))
    expect(button('Install manually…')).toBeDefined()
    expect(button('Show in File Explorer')).toBeUndefined()
  })
  it('coalesces reveal requests and retains instructions after an IPC rejection', async () => {
    render()
    await enter()
    let fail!: (error: Error) => void
    revealManualInstaller.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        })
    )
    act(() => {
      button('Show in File Explorer').click()
      button('Show in File Explorer').click()
    })
    expect(revealManualInstaller).toHaveBeenCalledOnce()
    expect(button('Show in File Explorer').disabled).toBe(true)
    await act(async () => fail(new Error('IPC failed')))
    expect(document.body.textContent).toContain('Could not show the installer. Try again.')
    expect(button('Show in File Explorer').disabled).toBe(false)
  })
  it('routes an invalid cache to website instructions but retains local instructions on reveal errors', async () => {
    render()
    await enter()
    revealManualInstaller.mockResolvedValue({ ...local, revealError: true })
    await act(async () => button('Show in File Explorer').click())
    expect(document.body.textContent).toContain('Could not show the installer. Try again.')
    expect(button('Show in File Explorer')).toBeDefined()
    revealManualInstaller.mockResolvedValue({ ...local, kind: 'website', reason: 'unavailable' })
    await act(async () => button('Show in File Explorer').click())
    expect(button('Show in File Explorer')).toBeUndefined()
    expect(document.body.textContent).not.toContain('setup.exe')
    expect(document.querySelector(`a[href="${APP.update.downloadPage}"]`)?.textContent).toContain(
      'Download from website'
    )
  })
  it('keeps authoritative local eligibility when a new download is selected', async () => {
    render()
    await enter()
    act(() => button('Use a new download instead').click())
    expect(document.body.textContent).toContain('Get a fresh full installer')
    expect(useUpdateStore.getState().status.manualInstall).toEqual(local)
    expect(revealManualInstaller).not.toHaveBeenCalled()
    await act(async () => button('Back to update').click())
    await enter()
    expect(button('Show in File Explorer')).toBeDefined()
  })
  it.each([
    [
      'darwin',
      'zip',
      'Show in Finder',
      'double-click the selected ZIP',
      'unpacked Open-Science.app'
    ],
    ['darwin', 'dmg', 'Show in Finder', 'DMG file selected', 'Open the downloaded DMG'],
    [
      'linux',
      'appimage',
      'Show in file manager',
      'AppImage selected',
      'Allow it to run as a program'
    ],
    ['linux', 'deb', 'Show in file manager', 'DEB file selected', 'system software installer']
  ] as const)('provides full %s %s instructions', async (platform, format, label, first, last) => {
    const info = { ...local, platform, format } as ManualInstallInfo
    useUpdateStore.setState({ status: status({ manualInstall: info }) })
    getManualInstall.mockResolvedValue(info)
    render()
    await enter()
    expect(button(label)).toBeDefined()
    expect(document.body.textContent).toContain(first)
    expect(document.body.textContent).toContain(last)
  })
  it('offers the same fallback in a recovered runtime dialog without cancelling recovery', async () => {
    const cancel = vi.fn(async () => {})
    useUpdateStore.setState({
      cancel,
      status: status({
        reason: 'install-failed',
        recovery: {
          runtime: 'running',
          installation: 'unchanged',
          phase: 'preparing',
          canCancel: true,
          canRecover: false,
          canRetryInstall: true
        }
      })
    })
    render()
    await enter()
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(button('Install manually…')).toBeDefined()
    expect(cancel).not.toHaveBeenCalled()
  })
})

it('rechecks main-process safety before explicit website navigation', async () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  try {
    render()
    await enter()
    act(() => button('Use a new download instead').click())
    const link = (): HTMLAnchorElement =>
      document.querySelector(`a[href="${APP.update.downloadPage}"]`)!
    await act(async () => link().click())
    expect(open).toHaveBeenCalledExactlyOnceWith(APP.update.downloadPage, '_blank', 'noreferrer')
    open.mockClear()
    getManualInstall.mockResolvedValue({ ...local, kind: 'blocked' })
    await act(async () => link().click())
    expect(open).not.toHaveBeenCalled()
    expect(button('Back to update')).toBeUndefined()
  } finally {
    open.mockRestore()
  }
})
