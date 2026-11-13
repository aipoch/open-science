import { randomUUID } from 'node:crypto'
import { validFileBasename, saveFileFormat } from './file-dialog-filename'
import { resolveSaveFileName } from '../shared/file-save-name'
import { mkdir, opendir, stat } from 'node:fs/promises'
import { fileFingerprint as fingerprint } from './user-file-publisher'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { FileDialogRequest, FileDialogSaveResult } from './file-dialog-protocol'
import type {
  FileDialogLocation,
  FileDialogUiAction,
  FileDialogUiReply,
  FileDialogUiState
} from '../shared/file-dialog-ui'

const MAX_DIRECTORY_ENTRIES = 100_000
const MAX_DIRECTORY_FOLDERS = 10_000

const validPath = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 32_768 && !value.includes('\0') && isAbsolute(value)

async function listLocation(path: string): Promise<FileDialogLocation> {
  if (!validPath(path)) throw new Error('Invalid directory')
  const absolute = resolve(path)
  const folders: FileDialogLocation['folders'] = []
  let visitedEntries = 0
  let visitedFolders = 0
  let truncated = false
  const directory = await opendir(absolute)
  for await (const entry of directory) {
    if (++visitedEntries > MAX_DIRECTORY_ENTRIES) {
      truncated = true
      break
    }
    const target = join(absolute, entry.name)
    const isFolder =
      entry.isDirectory() ||
      (entry.isSymbolicLink() && (await stat(target).catch(() => null))?.isDirectory())
    if (!isFolder) continue
    if (++visitedFolders > MAX_DIRECTORY_FOLDERS) {
      truncated = true
      break
    }
    folders.push({ name: entry.name, path: target })
  }
  folders.sort((a, b) => a.name.localeCompare(b.name))
  return { path: absolute, parent: dirname(absolute), folders, truncated }
}

export class FileDialogUiSession {
  private confirmation?: { token: string; path: string; fingerprint: string }
  private closed = false

  constructor(
    private readonly request: FileDialogRequest,
    private readonly defaults: Pick<FileDialogUiState, 'locale' | 'shortcuts'> &
      Partial<Pick<FileDialogUiState, 'appearance'>>,
    private readonly finish: (result: FileDialogSaveResult) => void,
    private readonly reportFailure: (code: string) => void
  ) {}

  private async initialState(): Promise<FileDialogUiState> {
    const initial = this.request.options.defaultPath ?? ''
    const initialIsDirectory =
      validPath(initial) && (await stat(initial).catch(() => null))?.isDirectory()
    const preferred = validPath(initial) ? (initialIsDirectory ? initial : dirname(initial)) : ''
    let location: FileDialogLocation | undefined
    for (const candidate of [preferred, ...this.defaults.shortcuts.map((item) => item.path)]) {
      if (!candidate) continue
      try {
        location = await listLocation(candidate)
        break
      } catch {
        // A stale default folder must not prevent selecting another destination.
      }
    }
    if (!location) throw new Error('No accessible initial directory')
    return {
      ...this.defaults,
      appearance: this.defaults.appearance ?? { theme: 'light', followsSystem: true },
      title: this.request.options.title,
      buttonLabel: this.request.options.buttonLabel,
      filename: initialIsDirectory ? '' : basename(initial),
      format: saveFileFormat(this.request.options),
      location
    }
  }

  async action(raw: unknown): Promise<FileDialogUiReply> {
    if (this.closed) return { type: 'done' }
    if (!raw || typeof raw !== 'object') return { type: 'error', code: 'destination' }
    const action = raw as FileDialogUiAction
    try {
      switch (action.type) {
        case 'init':
          return { type: 'init', state: await this.initialState() }
        case 'cancel':
          this.closed = true
          this.finish({ canceled: true, filePath: '' })
          return { type: 'done' }
        case 'browse':
          this.confirmation = undefined
          return { type: 'browse', location: await listLocation(action.path) }
        case 'mkdir': {
          this.confirmation = undefined
          if (
            !validPath(action.directory) ||
            typeof action.name !== 'string' ||
            !validFileBasename(action.name)
          )
            return { type: 'error', code: 'filename' }
          const path = join(action.directory, action.name)
          await mkdir(path)
          return { type: 'browse', location: await listLocation(path) }
        }
        case 'select': {
          this.confirmation = undefined
          if (!validPath(action.directory) || !(await stat(action.directory)).isDirectory())
            return { type: 'error', code: 'folder' }
          let filename = action.filename
          if (typeof filename !== 'string' || !validFileBasename(filename))
            return { type: 'error', code: 'filename' }
          const resolved = resolveSaveFileName(filename, saveFileFormat(this.request.options))
          if (resolved.kind === 'review')
            return { type: 'error', code: 'extension', suggestions: resolved }
          filename = resolved.filename
          if (!resolved.stem || !validFileBasename(filename))
            return { type: 'error', code: 'filename' }
          const path = join(action.directory, filename)
          const existing = await fingerprint(path)
          if (existing !== null) {
            const token = randomUUID()
            this.confirmation = { token, path, fingerprint: existing }
            return { type: 'confirm', filename, token }
          }
          this.closed = true
          this.finish({ canceled: false, filePath: path, target: { path, fingerprint: null } })
          return { type: 'done' }
        }
        case 'replace': {
          const pending = this.confirmation
          this.confirmation = undefined
          if (
            !pending ||
            action.token !== pending.token ||
            (await fingerprint(pending.path)) !== pending.fingerprint
          )
            return { type: 'error', code: 'changed' }
          this.closed = true
          this.finish({
            canceled: false,
            filePath: pending.path,
            target: { path: pending.path, fingerprint: pending.fingerprint }
          })
          return { type: 'done' }
        }
        default:
          return { type: 'error', code: 'destination' }
      }
    } catch (error) {
      // Paths and filenames are private; only a bounded error code enters diagnostics.
      const code = (error as NodeJS.ErrnoException).code
      this.reportFailure(code && /^[A-Z_]{2,32}$/.test(code) ? code : 'selection-failed')
      return {
        type: 'error',
        code: action.type === 'browse' || action.type === 'init' ? 'folder' : 'destination'
      }
    }
  }
}
