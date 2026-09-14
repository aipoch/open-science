import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { BRAND_APP_ID, upgradeMacBundle, upgradeWindowsShortcuts } from './system-paths'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
const mac = (): {
  old: string
  next: string
  deps: import('./system-paths').MacBundleUpgradeDeps
} => {
  const root = mkdtempSync(join(tmpdir(), 'brand-app-'))
  roots.push(root)
  const old = join(root, 'Open Science.app')
  const next = join(root, 'Open-Science.app')
  mkdirSync(join(old, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(old, 'Contents', 'MacOS', 'Open-Science'), 'executable')
  const deps = {
    exists: existsSync,
    bundleId: () => BRAND_APP_ID,
    verify: vi.fn(),
    rename: renameSync,
    register: vi.fn(),
    updateDock: vi.fn(),
    relaunch: vi.fn()
  }
  return { old, next, deps }
}
it('renames an upgraded old .app in place and relaunches its real executable before other startup work', () => {
  const { old, next, deps } = mac()
  expect(upgradeMacBundle(join(old, 'Contents', 'MacOS', 'Open-Science'), deps)).toBe(true)
  expect(existsSync(old)).toBe(false)
  expect(existsSync(join(next, 'Contents', 'MacOS', 'Open-Science'))).toBe(true)
  expect(deps.relaunch).toHaveBeenCalledWith(join(next, 'Contents', 'MacOS', 'Open-Science'))
  expect(deps.updateDock).toHaveBeenCalledWith(next, expect.arrayContaining([old]))
})
it('refuses a duplicate destination without changing either installed bundle', () => {
  const { old, next, deps } = mac()
  mkdirSync(next)
  expect(() => upgradeMacBundle(join(old, 'Contents', 'MacOS', 'Open-Science'), deps)).toThrow(
    /two|duplicate/i
  )
  expect(existsSync(old)).toBe(true)
  expect(existsSync(next)).toBe(true)
  expect(deps.relaunch).not.toHaveBeenCalled()
})
it('repairs old Dock references after Squirrel has already renamed the bundle', () => {
  const { old, next, deps } = mac()
  renameSync(old, next)
  expect(upgradeMacBundle(join(next, 'Contents', 'MacOS', 'Open-Science'), deps)).toBe(false)
  expect(deps.updateDock).toHaveBeenCalledWith(next, expect.arrayContaining([old]))
})
it('does not touch a foreign bundle or a user-named bundle', () => {
  const { old, deps } = mac()
  deps.bundleId = () => 'other.app'
  expect(() => upgradeMacBundle(join(old, 'Contents', 'MacOS', 'Open-Science'), deps)).toThrow(
    /identity/i
  )
  expect(existsSync(old)).toBe(true)
  expect(upgradeMacBundle('/Applications/My Research.app/Contents/MacOS/Open-Science', deps)).toBe(
    false
  )
})
it('updates only owned Windows shortcuts and retains arguments by using sparse update before rename notification', () => {
  const exe = 'C:\\Apps\\Open-Science\\open-science.exe'
  const link = 'C:\\Pins\\Open Science.lnk'
  const calls: unknown[] = []
  const deps = {
    exists: () => false,
    read: () => ({ target: exe, appUserModelId: BRAND_APP_ID, description: 'Open Science' }),
    update: vi.fn((p, c) => {
      calls.push(['update', p, c])
      return true
    }),
    rename: vi.fn((a, b) => calls.push(['rename', a, b])),
    notifyRename: vi.fn((a, b) => calls.push(['notify', a, b]))
  }
  upgradeWindowsShortcuts([link], exe, deps)
  expect(calls).toEqual([
    ['update', link, { description: 'Open-Science' }],
    ['rename', link, 'C:\\Pins\\Open-Science.lnk'],
    ['notify', link, 'C:\\Pins\\Open-Science.lnk']
  ])
  deps.read = () => ({ target: 'C:\\Foreign.exe', appUserModelId: 'other', description: '' })
  upgradeWindowsShortcuts([link], exe, deps)
  expect(deps.update).toHaveBeenCalledTimes(1)
})
it('refuses Windows name collisions instead of overwriting a pinned shortcut', () => {
  const deps = {
    exists: () => true,
    read: () => ({ target: 'C:\\Apps\\open-science.exe' }),
    update: vi.fn(() => true),
    rename: vi.fn(),
    notifyRename: vi.fn()
  }
  expect(() =>
    upgradeWindowsShortcuts(['C:\\Pins\\Open Science.lnk'], 'C:\\Apps\\open-science.exe', deps)
  ).toThrow(/shortcut/i)
  expect(deps.rename).not.toHaveBeenCalled()
})

it('repairs a Linux desktop copy while retaining its launch options and unrelated content', async () => {
  const { upgradeLinuxDesktopEntry } = await import('./system-paths')
  const source =
    '[Desktop Entry]\nName=Open Science\nExec="/opt/Open Science/open-science" --user-option %U\nIcon=/opt/Open Science/icon.png\n[Other]\nName=Open Science\n'
  expect(upgradeLinuxDesktopEntry(source, '/opt/Open-Science/open-science')).toBe(
    '[Desktop Entry]\nName=Open-Science\nExec="/opt/Open-Science/open-science" --user-option %U\nIcon=/opt/Open-Science/icon.png\n[Other]\nName=Open Science\n'
  )
  expect(
    upgradeLinuxDesktopEntry(
      '[Desktop Entry]\nName=Open Science\nExec=/opt/foreign/bin\n',
      '/opt/Open-Science/open-science'
    )
  ).toContain('Name=Open Science')
})

it('leaves unreadable shortcuts untouched and continues with a verified link', () => {
  const exe = 'C:\\Apps\\open-science.exe'
  const bad = 'C:\\Desktop\\Open Science.lnk'
  const good = 'C:\\Pins\\Open Science.lnk'
  const deps = {
    exists: () => false,
    read: (path: string) => {
      if (path === bad) throw new Error('Invalid shortcut')
      return { target: exe }
    },
    update: vi.fn(() => true),
    rename: vi.fn(),
    notifyRename: vi.fn(),
    reportUnreadable: vi.fn()
  }
  expect(() => upgradeWindowsShortcuts([bad, good], exe, deps)).not.toThrow()
  expect(deps.reportUnreadable).toHaveBeenCalledWith(bad, expect.any(Error))
  expect(deps.update).toHaveBeenCalledExactlyOnceWith(good, { description: 'Open-Science' })
})

it('does not redirect an installed deb launcher to a coexisting AppImage', async () => {
  const { upgradeLinuxDesktopEntry } = await import('./system-paths')
  const entry = '[Desktop Entry]\nName=Open Science\nExec="/opt/Open Science/open-science" %U\n'
  expect(upgradeLinuxDesktopEntry(entry, '/home/user/Downloads/Open-Science.AppImage')).toBe(entry)
})
