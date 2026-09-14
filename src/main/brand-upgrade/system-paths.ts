import { basename, dirname, join, win32 } from 'node:path'

export const BRAND_APP_ID = 'com.aipoch.open-science'
export type MacBundleUpgradeDeps = {
  exists: (path: string) => boolean
  bundleId: (bundle: string) => string
  verify: (bundle: string) => void
  rename: (from: string, to: string) => void
  register: (bundle: string, previous: string[]) => void
  updateDock: (bundle: string, previous: string[]) => void
  relaunch: (executable: string) => void
}
export const upgradeMacBundle = (executable: string, deps: MacBundleUpgradeDeps): boolean => {
  const bundle = dirname(dirname(dirname(executable)))
  const recognized = ['Open Science.app', 'OpenScience.app', 'Open-Science.app']
  if (!recognized.includes(basename(bundle))) return false
  if (deps.bundleId(bundle) !== BRAND_APP_ID)
    throw new Error(`Application brand upgrade: unexpected bundle identity at ${bundle}`)
  const destination = join(dirname(bundle), 'Open-Science.app')
  const previous = recognized.slice(0, 2).map((name) => join(dirname(bundle), name))
  if (bundle !== destination) {
    if (deps.exists(destination))
      throw new Error(
        `Application brand upgrade: two applications exist. Keep the intended installation before restarting:\n${bundle}\n${destination}`
      )
    deps.verify(bundle)
    deps.rename(bundle, destination)
    // Relaunch uses the renamed physical executable; updater and CLI bootstrap never see a stale path.
    deps.register(destination, previous)
    deps.updateDock(destination, previous)
    deps.relaunch(join(destination, 'Contents', 'MacOS', basename(executable)))
    return true
  }
  for (const old of previous) {
    if (deps.exists(old) && deps.bundleId(old) === BRAND_APP_ID)
      throw new Error(
        `Application brand upgrade: duplicate applications exist. Remove the obsolete application bundle before restarting:\n${old}\n${bundle}`
      )
  }
  deps.register(destination, previous)
  deps.updateDock(destination, previous)
  return false
}

export type ShortcutDetails = { target: string; appUserModelId?: string; description?: string }
export type WindowsShortcutDeps = {
  exists: (path: string) => boolean
  reportUnreadable?: (path: string, error: unknown) => void
  read: (path: string) => ShortcutDetails
  update: (path: string, changes: { description: string }) => boolean
  rename: (from: string, to: string) => void
  notifyRename: (from: string, to: string) => void
}
export const upgradeWindowsShortcuts = (
  paths: string[],
  executable: string,
  deps: WindowsShortcutDeps
): void => {
  const target = win32.normalize(executable).toLowerCase()
  for (const path of paths) {
    if (!['Open Science.lnk', 'OpenScience.lnk', 'Open-Science.lnk'].includes(win32.basename(path)))
      continue
    let shortcut: ShortcutDetails
    try {
      shortcut = deps.read(path)
    } catch (error) {
      // An unreadable link has no verified ownership. Preserve it and inspect the remaining links.
      deps.reportUnreadable?.(path, error)
      continue
    }
    if (
      win32.normalize(shortcut.target).toLowerCase() !== target ||
      (shortcut.appUserModelId && shortcut.appUserModelId !== BRAND_APP_ID)
    )
      continue
    const destination = win32.join(win32.dirname(path), 'Open-Science.lnk')
    if (path !== destination && deps.exists(destination))
      throw new Error(
        `Application brand upgrade: duplicate shortcut at ${destination}. Resolve it before restarting.`
      )
    // Sparse update preserves arguments, working directory, and unexposed .lnk properties.
    if (!deps.update(path, { description: 'Open-Science' }))
      throw new Error(`Application brand upgrade: could not update shortcut ${path}`)
    if (path !== destination) {
      deps.rename(path, destination)
      deps.notifyRename(path, destination)
    }
  }
}

// Package-managed .desktop filenames stay stable. Repair user copies only when their executable
// belongs to this product, preserving options and all unrelated desktop-entry groups.
export const upgradeLinuxDesktopEntry = (contents: string, executable: string): string => {
  const lines = contents.split('\n')
  const start = lines.indexOf('[Desktop Entry]')
  if (start < 0) return contents
  const nextGroup = lines.findIndex((line, index) => index > start && /^\[/.test(line))
  const end = nextGroup < 0 ? lines.length : nextGroup
  const execIndex = lines.findIndex(
    (line, index) => index > start && index < end && line.startsWith('Exec=')
  )
  if (execIndex < 0) return contents
  const allowed = [
    executable,
    ...(executable === '/opt/Open-Science/open-science'
      ? ['/opt/Open Science/open-science', '/opt/OpenScience/open-science']
      : [])
  ]
  const value = lines[execIndex].slice(5)
  const owned = allowed
    .flatMap((path) => [path, `"${path}"`])
    .find((path) => value === path || value.startsWith(path + ' '))
  if (!owned) return contents
  const quoted = `"${executable.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('`', '\\`').replaceAll('$', '\\$')}"`
  lines[execIndex] = 'Exec=' + quoted + value.slice(owned.length)
  for (let i = start + 1; i < end; i++) {
    if (/^Name(?:\[[^\]]+\])?=(Open Science|OpenScience)$/.test(lines[i]))
      lines[i] = lines[i].replace(/=(?:Open Science|OpenScience)$/, '=Open-Science')
    if (/^Icon=\/opt\/(?:Open Science|OpenScience)\//.test(lines[i]))
      lines[i] = lines[i].replace(/\/opt\/(?:Open Science|OpenScience)\//, '/opt/Open-Science/')
  }
  return lines.join('\n')
}
