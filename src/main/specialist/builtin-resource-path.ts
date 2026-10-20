import { runtimeMetadata } from '../runtime-metadata'
import { join } from 'node:path'

export const toUnpackedSpecialistResourcePath = (filePath: string): string =>
  filePath.replace(/([/\\])app\.asar([/\\])/, '$1app.asar.unpacked$2')

export const resolveBundledSpecialistsRoot = (): string =>
  toUnpackedSpecialistResourcePath(
    join(runtimeMetadata().applicationPath, 'resources', 'specialists')
  )
