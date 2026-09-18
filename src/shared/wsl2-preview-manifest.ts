import resourceManifest from '../../packages/notebook-network-sandbox/vendor/wsl2/manifest.json'

// Compatibility metadata, not evidence that a particular release passed certification.
// Asset revisions change when their runtime contracts change, independently of app releases.
export const WSL2_BASH_PREVIEW_MANIFEST = Object.freeze({
  schemaVersion: resourceManifest.schemaVersion,
  assets: Object.freeze([...resourceManifest.assets])
})

export const matchesWsl2BashPreviewManifest = (candidate: unknown): boolean => {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
  const manifest = candidate as Record<string, unknown>
  return (
    Object.keys(manifest).sort().join('\n') === 'assets\nschemaVersion' &&
    manifest.schemaVersion === WSL2_BASH_PREVIEW_MANIFEST.schemaVersion &&
    Array.isArray(manifest.assets) &&
    manifest.assets.length === WSL2_BASH_PREVIEW_MANIFEST.assets.length &&
    manifest.assets.every((asset, index) => asset === WSL2_BASH_PREVIEW_MANIFEST.assets[index])
  )
}
