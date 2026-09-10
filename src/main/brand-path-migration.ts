import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { App } from 'electron'

type BrandMigrationApp = Pick<App, 'isPackaged' | 'getPath' | 'getAppPath' | 'commandLine' | 'on'>

// Synchronous on purpose: Electron must not reach ready (and open Chromium databases/logs) while
// the offline child prepares the profile. The child has no Electron imports or application writers.
export const prepareBrandPathMigration = (
  app: BrandMigrationApp
): { userData?: string; reconcileProtectedPaths: () => Promise<void> } => {
  const isolatedRoot =
    process.env.OPEN_SCIENCE_E2E_STORAGE_ROOT?.trim() ||
    (!app.isPackaged ? process.env.OPEN_SCIENCE_STORAGE_ROOT?.trim() : undefined)
  const explicitProfile = app.commandLine.hasSwitch('user-data-dir')
    ? app.getPath('userData')
    : !app.isPackaged
      ? process.env.OPEN_SCIENCE_USER_DATA?.trim()
      : undefined
  const home = isolatedRoot ?? app.getPath('home')
  const appData = isolatedRoot ? join(isolatedRoot, 'electron-app-data') : app.getPath('appData')
  const configRoot =
    isolatedRoot ?? join(home, app.isPackaged ? '.open-science' : '.open-science-project')
  for (const path of [home, appData, configRoot, explicitProfile].filter(Boolean)) {
    if (!isAbsolute(path!)) throw new Error('Brand migration requires absolute storage paths.')
  }
  const appRoot = app.getAppPath().replace(/\.asar$/, '.asar.unpacked')
  const script = join(appRoot, 'resources', 'brand-migration', 'cli.mjs')
  const args = [
    script,
    '--home',
    home,
    '--app-data',
    appData,
    '--mode',
    app.isPackaged ? 'packaged' : 'dev',
    '--config-root',
    configRoot,
    '--execute',
    '--recover-lock',
    '--startup-owner',
    String(process.pid)
  ]
  if (!app.commandLine.hasSwitch('open-science-headless')) args.push('--show-progress-window')
  if (!app.isPackaged && process.env.OPEN_SCIENCE_ALLOW_MULTI_INSTANCE === '1')
    args.push('--allow-multi-instance')
  if (isolatedRoot) args.push('--data-parent', isolatedRoot)
  if (explicitProfile) args.push('--user-data', explicitProfile)
  if (process.platform === 'win32') {
    args.push(
      '--local-app-data',
      isolatedRoot
        ? join(isolatedRoot, 'local-app-data')
        : (process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'))
    )
    for (const temp of isolatedRoot
      ? [join(isolatedRoot, 'temp')]
      : [process.env.TEMP, process.env.TMP].filter(Boolean))
      args.push('--temp-parent', temp!)
  }
  // Node mode uses the already-running Electron payload (also works inside an AppImage mount).
  const result = spawnSync(process.execPath, args, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
    encoding: 'utf8',
    // Keep the receipt machine-readable, but do not buffer live diagnostics until migration ends.
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      result.stderr?.trim() || result.error?.message || 'Brand path migration failed.'
    )
  }
  const receipt = JSON.parse(result.stdout) as {
    userData?: string
    relayOnly?: boolean
    lease?: { path: string; token: string }
  }
  if (receipt.lease) {
    const lease = receipt.lease
    app.on('quit', () => {
      // Only this process's lease may be removed. A killed process leaves a recoverable stale lease.
      try {
        const owner = JSON.parse(readFileSync(lease.path, 'utf8'))
        if (owner.pid === process.pid && owner.token === lease.token) rmSync(lease.path)
      } catch {
        /* Preserve an unreadable lease for explicit recovery. */
      }
    })
  }
  return {
    userData: receipt.userData,
    reconcileProtectedPaths: async () => {
      if (receipt.relayOnly) return
      const { safeStorage } = await import('electron')
      const { isSecureStorageAvailable } = await import('./secure-storage')
      const moduleUrl = pathToFileURL(
        join(appRoot, 'resources', 'brand-migration', 'online.mjs')
      ).href
      const migration = await import(/* @vite-ignore */ moduleUrl)
      const stateDir = `${configRoot}.brand-migration`
      await migration.reconcileProtectedPaths(stateDir, {
        decrypt: (raw: string) => {
          if (!isSecureStorageAvailable(safeStorage))
            throw new Error('Unlock the OS credential store to migrate protected task paths.')
          const envelope = JSON.parse(raw) as [string, string]
          const prefix = 'open-science:protected:v1:'
          if (!envelope[1].startsWith(prefix)) throw new Error('Invalid protected task envelope.')
          return safeStorage.decryptString(Buffer.from(envelope[1].slice(prefix.length), 'base64'))
        },
        encrypt: (raw: string) =>
          JSON.stringify([
            'open-science:protected-json:v1',
            `open-science:protected:v1:${safeStorage.encryptString(raw).toString('base64')}`
          ])
      })
      const { ensureCliLauncherCurrent, migrateCliLauncherProfile } =
        await import('./cli-install/launcher')
      const env = {
        platform: process.platform,
        appExecPath: process.execPath,
        cliEntryPath: app.isPackaged
          ? join(process.resourcesPath, 'cli', 'index.mjs')
          : join(app.getAppPath(), 'cli', 'index.mjs'),
        appImagePath: process.env.APPIMAGE,
        packaged: app.isPackaged,
        homeDir: home,
        userDataDir: receipt.userData ?? app.getPath('userData'),
        pathVar: process.env.PATH ?? ''
      }
      if (process.platform === 'win32') {
        const journal = JSON.parse(readFileSync(join(stateDir, 'journal.json'), 'utf8'))
        const profile = journal.mappings.find(
          (m: { kind: string; to: string; from: string; state: string; aliasRequired?: boolean }) =>
            m.kind === 'profile' &&
            m.to === env.userDataDir &&
            (m.state === 'move' || m.aliasRequired)
        )
        if (profile && !journal.aliasesRetiredAt)
          await migrateCliLauncherProfile(env, profile.from, stateDir)
      }
      await ensureCliLauncherCurrent(env)
    }
  }
}
