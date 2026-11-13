import { basename, isAbsolute } from 'node:path'
import type { SaveDialogOptions } from 'electron'
import { resolveSaveFileFormat, resolveSaveFileName } from '../shared/file-save-name'

export function validWindowsFilename(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    !/[<>:"/\\|?*]/.test(name) &&
    !Array.from(name).some((character) => character.charCodeAt(0) < 32) &&
    !/[. ]$/.test(name) &&
    !/^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/i.test(name)
  )
}

export function validFileBasename(name: string): boolean {
  if (process.platform === 'win32') return validWindowsFilename(name)
  return (
    name.length > 0 &&
    Buffer.byteLength(name) <= 255 &&
    name !== '.' &&
    name !== '..' &&
    !/[\0/:]/.test(name)
  )
}

export function saveFileFormat(
  options: Pick<SaveDialogOptions, 'defaultPath' | 'filters'>
): ReturnType<typeof resolveSaveFileFormat> {
  return resolveSaveFileFormat(basename(options.defaultPath ?? ''), options.filters)
}

// Revalidate at the writer-facing boundary. Never append a suffix here: overwrite consent belongs
// to the exact path reviewed in the picker, not a different path constructed after it closes.
export function assertSelectedSavePath(
  options: Pick<SaveDialogOptions, 'defaultPath' | 'filters'>,
  path: unknown
): asserts path is string {
  if (
    typeof path !== 'string' ||
    !isAbsolute(path) ||
    path.includes('\0') ||
    !validFileBasename(basename(path))
  )
    throw new Error('Invalid export destination.')
  const name = basename(path)
  const resolved = resolveSaveFileName(name, saveFileFormat(options))
  if (resolved.kind !== 'ready' || resolved.filename !== name || !resolved.stem)
    throw new Error('Export filename does not match its file type.')
}
