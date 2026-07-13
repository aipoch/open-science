import { join } from 'node:path'

import { app } from 'electron'

// Electron packs `resources/**` outside the asar (asarUnpack). Mirror agent-process.ts so dev
// (no asar in the path → no-op) and packaged (rewrite app.asar → app.asar.unpacked) both resolve.
const toUnpackedAsarPath = (filePath: string): string =>
  filePath.replace(/([/\\])app\.asar([/\\])/, '$1app.asar.unpacked$2')

// Absolute path to the bundled skills root shipped with the app.
const resolveBundledSkillsRoot = (): string =>
  toUnpackedAsarPath(join(app.getAppPath(), 'resources', 'skills'))

export { resolveBundledSkillsRoot, toUnpackedAsarPath }
