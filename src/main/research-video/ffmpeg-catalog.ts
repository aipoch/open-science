import assets from './ffmpeg-assets.json'
import type { LocalModelRevision } from '../local-models/catalog'

// Upstream ffmpeg-static b6.1.1 release assets, pinned by size and SHA-256.
// Download the binaries and their upstream licensing/source notices only on explicit installation.
export const videoExportTarget = `${process.platform}-${process.arch}`
export const VIDEO_EXPORT_REVISIONS: readonly LocalModelRevision[] = [...assets]
  .sort((a, b) => Number(b.target === videoExportTarget) - Number(a.target === videoExportTarget))
  .map(({ target, assets }) => ({ revision: `ffmpeg-6-1-1-${target}`, assets }))
export const videoExportBinaries = assets.find(
  ({ target }) => target === videoExportTarget
)?.binaries
