// Cross-process update types and pure helpers. No Electron/Node I/O so both main and renderer import it.

export type PlatformDownload = { url: string; size: number; sha256: string }

export type UpdateManifest = {
  version: string
  releaseDate: string
  notes: string
  downloads: Record<string, PlatformDownload>
}

export type UpdateState =
  'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error'

// The single status the main process broadcasts and the renderer store mirrors.
export type UpdateStatus = {
  state: UpdateState
  current: string
  latest?: string
  notes?: string
  download?: PlatformDownload
  progress?: number // 0-100 while downloading
  localPath?: string // set when state === 'ready'
  error?: string
  // How the renderer applies a ready update: open the downloaded installer (mac manual reinstall) or
  // restart into an in-place electron-updater install (win/linux). Set by the active strategy.
  applyKind?: 'installer' | 'restart'
}

export type AppInfo = { name: string; version: string; copyright: string }

// Numeric dotted-version compare. Missing components count as 0, so '1.0' === '1.0.0'. Non-numeric
// components (e.g. pre-release tags) degrade to 0 — adequate for the simple x.y.z release manifest.
export const compareVersions = (a: string, b: string): -1 | 0 | 1 => {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da > db) return 1
    if (da < db) return -1
  }
  return 0
}

export const isNewer = (latest: string, current: string): boolean =>
  compareVersions(latest, current) > 0

// Maps the host to its manifest download key. Linux prefers the deb; selectDownload falls back to
// the AppImage when the deb is absent.
export const platformDownloadKey = (platform: NodeJS.Platform, arch: string): string | null => {
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  if (platform === 'win32') return 'win-x64'
  if (platform === 'linux') return 'linux-x64-deb'
  return null
}

export const selectDownload = (
  manifest: UpdateManifest,
  platform: NodeJS.Platform,
  arch: string
): PlatformDownload | null => {
  const key = platformDownloadKey(platform, arch)
  if (key && manifest.downloads[key]) return manifest.downloads[key]
  if (platform === 'linux' && manifest.downloads['linux-x64-appimage']) {
    return manifest.downloads['linux-x64-appimage']
  }
  return null
}
