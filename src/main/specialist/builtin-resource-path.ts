import { join } from 'node:path'

import { app } from 'electron'

export const toUnpackedSpecialistResourcePath = (filePath: string): string =>
  filePath.replace(/([/\\])app\.asar([/\\])/, '$1app.asar.unpacked$2')

export const resolveBundledSpecialistsRoot = (): string =>
  toUnpackedSpecialistResourcePath(join(app.getAppPath(), 'resources', 'specialists'))
