import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, shell } from 'electron'
import { createLogger } from '../logger'
import { resolveWindowsPowerShellExecutable } from '../windows-powershell'
import { upgradeLinuxDesktopEntry, upgradeMacBundle, upgradeWindowsShortcuts } from './system-paths'

// Update only this application's existing Dock items. Keep ordering, pin choices, and every other
// preference. Clear its stale bookmark so Dock rebuilds it from the verified new file URL.
const dockScript = `ObjC.import('Foundation');
function run(argv) {
 const current = argv[0], previous = argv.slice(1);
 const preferences = $.NSUserDefaults.alloc.initWithSuiteName('com.apple.dock');
 const original = preferences.objectForKey('persistent-apps');
 if (!original) return;
 const items = original.mutableCopy;
 let changed = false;
 for (let i = 0; i < Number(items.count); i++) {
  const item = items.objectAtIndex(i).mutableCopy;
  const data = item.objectForKey('tile-data');
  if (!data) continue;
  const file = data.objectForKey('file-data');
  if (!file) continue;
  const raw = file.objectForKey('_CFURLString');
  if (!raw) continue;
  const url = $.NSURL.URLWithString(raw);
  const path = ObjC.unwrap(url.path);
  const identity = data.objectForKey('bundle-identifier');
  if (ObjC.unwrap(identity) !== 'com.aipoch.open-science') continue;
  if (path !== current && !previous.includes(path)) continue;
  const label = data.objectForKey('file-label');
  if (path === current && ObjC.unwrap(label) === 'Open-Science') continue;
  const next = data.mutableCopy;
  const nextFile = file.mutableCopy;
  nextFile.setObjectForKey($.NSURL.fileURLWithPath(current).absoluteString, '_CFURLString');
  next.setObjectForKey(nextFile, 'file-data');
  next.setObjectForKey('Open-Science', 'file-label');
  next.removeObjectForKey('book');
  item.setObjectForKey(next, 'tile-data');
  items.replaceObjectAtIndexWithObject(i, item);
  changed = true;
 }
 if (changed) { preferences.setObjectForKey(items, 'persistent-apps'); preferences.synchronize; return 'changed'; }
}`

export const upgradeNativeBrandEntries = (): boolean => {
  // Task/certification isolation never touches the user's actual Dock or pinned shortcuts.
  if (
    !app.isPackaged ||
    process.env.OPEN_SCIENCE_CONFIG_ROOT ||
    process.env.OPEN_SCIENCE_E2E_STORAGE_ROOT ||
    process.env.OPEN_SCIENCE_USER_DATA
  )
    return false
  if (process.platform === 'darwin') {
    const lsregister =
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
    return upgradeMacBundle(process.execPath, {
      exists: existsSync,
      bundleId: (bundle) =>
        execFileSync(
          '/usr/libexec/PlistBuddy',
          ['-c', 'Print :CFBundleIdentifier', join(bundle, 'Contents', 'Info.plist')],
          { encoding: 'utf8' }
        ).trim(),
      verify: (bundle) => {
        execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle])
      },
      rename: renameSync,
      register: (bundle, previous) => {
        execFileSync(lsregister, ['-f', bundle])
        for (const old of previous)
          if (!existsSync(old)) {
            try {
              execFileSync(lsregister, ['-u', old], { stdio: 'ignore' })
            } catch {
              /* The old registration may already be absent. */
            }
          }
      },
      updateDock: (bundle, previous) => {
        const result = execFileSync(
          '/usr/bin/osascript',
          ['-l', 'JavaScript', '-e', dockScript, bundle, ...previous],
          { encoding: 'utf8' }
        )
        if (result.trim() === 'changed')
          execFileSync('/usr/bin/killall', ['-u', String(process.getuid?.()), 'Dock'], {
            stdio: 'ignore'
          })
      },
      relaunch: (executable) => {
        app.relaunch({ execPath: executable, args: process.argv.slice(1) })
        app.exit(0)
      }
    })
  }
  if (process.platform === 'win32') {
    const appData = app.getPath('appData')
    const quickLaunch = join(
      appData,
      'Microsoft',
      'Internet Explorer',
      'Quick Launch',
      'User Pinned'
    )
    const directories = [
      app.getPath('desktop'),
      join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      join(quickLaunch, 'TaskBar')
    ]
    const implicit = join(quickLaunch, 'ImplicitAppShortcuts')
    if (existsSync(implicit))
      for (const entry of readdirSync(implicit, { withFileTypes: true })) {
        if (entry.isDirectory()) directories.push(join(implicit, entry.name))
      }
    const paths = directories.flatMap((dir) =>
      existsSync(dir)
        ? readdirSync(dir)
            .filter((name) => name.endsWith('.lnk'))
            .map((name) => join(dir, name))
        : []
    )
    upgradeWindowsShortcuts(paths, process.execPath, {
      exists: existsSync,
      read: shell.readShortcutLink,
      reportUnreadable: (path, error) =>
        createLogger('brand-upgrade').warn('Unreadable shortcut left untouched', { path, error }),
      update: (path, changes) =>
        // Electron's runtime supports sparse updates; its declaration requires target for every mode.
        shell.writeShortcutLink(path, 'update', changes as Electron.ShortcutDetails),
      rename: renameSync,
      notifyRename: (from, to) => {
        const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`
        const command = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class BrandShell { [DllImport("shell32.dll", CharSet=CharSet.Unicode)] public static extern void SHChangeNotify(uint e, uint f, string a, string b); }'; [BrandShell]::SHChangeNotify(1, 0x3005, ${literal(from)}, ${literal(to)})`
        execFileSync(
          resolveWindowsPowerShellExecutable(),
          [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(command, 'utf16le').toString('base64')
          ],
          { windowsHide: true }
        )
      }
    })
  }
  if (process.platform === 'linux') {
    const directories = [
      app.getPath('desktop'),
      join(
        process.env.XDG_DATA_HOME || join(app.getPath('home'), '.local', 'share'),
        'applications'
      )
    ]
    for (const directory of directories)
      for (const name of ['open-science.desktop', 'Open Science.desktop', 'OpenScience.desktop']) {
        const path = join(directory, name)
        if (!existsSync(path)) continue
        const contents = readFileSync(path, 'utf8')
        const updated = upgradeLinuxDesktopEntry(contents, process.env.APPIMAGE || process.execPath)
        if (contents !== updated) writeFileSync(path, updated)
      }
  }
  return false
}
