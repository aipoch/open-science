import { createRequire } from 'node:module'
import * as nodeFs from 'node:fs'

// Installation operations inspect and replace physical files. Electron's node:fs adapter
// exposes ASAR archives as virtual directories, which must not affect manifests or copies.
// Resolve the Electron builtin without import.meta so Node, CJS tests and desktop bundles
// can all load this module. Ordinary Node never tries to resolve original-fs.
export const installationFs: typeof nodeFs = process.versions.electron
  ? createRequire(process.execPath)('original-fs')
  : nodeFs
