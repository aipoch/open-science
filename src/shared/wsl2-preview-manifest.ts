export const WSL2_BASH_PREVIEW_MANIFEST = Object.freeze({
  schemaVersion: 1,
  appVersion: '0.25.1',
  assets: Object.freeze([
    'wsl2-execution-wrapper-v1',
    'wsl2-exact-cleanup-v1',
    'wsl2-network-bridge-v1'
  ])
})

export const matchesWsl2BashPreviewManifest = (candidate: unknown, appVersion: string): boolean => {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
  const manifest = candidate as Record<string, unknown>
  return (
    Object.keys(manifest).sort().join('\n') === 'appVersion\nassets\nschemaVersion' &&
    manifest.schemaVersion === WSL2_BASH_PREVIEW_MANIFEST.schemaVersion &&
    manifest.appVersion === appVersion &&
    manifest.appVersion === WSL2_BASH_PREVIEW_MANIFEST.appVersion &&
    Array.isArray(manifest.assets) &&
    manifest.assets.length === WSL2_BASH_PREVIEW_MANIFEST.assets.length &&
    manifest.assets.every((asset, index) => asset === WSL2_BASH_PREVIEW_MANIFEST.assets[index])
  )
}
