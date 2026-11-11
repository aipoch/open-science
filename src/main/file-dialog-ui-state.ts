import { randomUUID } from 'node:crypto'
import { lstat, mkdir, opendir, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import type { FileDialogRequest, FileDialogResult } from './file-dialog-protocol'
import type {
  FileDialogLocation,
  FileDialogUiAction,
  FileDialogUiReply,
  FileDialogUiState
} from '../shared/file-dialog-ui'

const validPath = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 32_768 && !value.includes('\0') && isAbsolute(value)

export function validWindowsFilename(name: string): boolean {
  // Reject aliases and path syntax before joining; the publisher must receive one basename.
  return (
    name.length > 0 &&
    name.length <= 255 &&
    !/[<>:"/\\|?*]/.test(name) &&
    !Array.from(name).some((character) => character.charCodeAt(0) < 32) &&
    !/[. ]$/.test(name) &&
    !/^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/i.test(name)
  )
}

async function listLocation(path: string): Promise<FileDialogLocation> {
  if (!validPath(path)) throw new Error('Invalid directory')
  const absolute = resolve(path)
  const folders: FileDialogLocation['folders'] = []
  let visited = 0
  let truncated = false
  const directory = await opendir(absolute)
  for await (const entry of directory) {
    if (++visited > 10_000) {
      truncated = true
      break
    }
    const target = join(absolute, entry.name)
    if (
      entry.isDirectory() ||
      (entry.isSymbolicLink() && (await stat(target).catch(() => null))?.isDirectory())
    )
      folders.push({ name: entry.name, path: target })
  }
  folders.sort((a, b) => a.name.localeCompare(b.name))
  return { path: absolute, parent: dirname(absolute), folders, truncated }
}

async function fingerprint(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path, { bigint: true })
    // Never confirm replacing a directory, symlink or device through this file-only UI.
    if (!info.isFile()) throw new Error('Destination is not a regular file')
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export class FileDialogUiSession {
  private confirmation?: { token: string; path: string; fingerprint: string }
  private closed = false

  constructor(
    private readonly request: FileDialogRequest,
    private readonly defaults: Pick<FileDialogUiState, 'locale' | 'shortcuts'>,
    private readonly finish: (result: FileDialogResult) => void,
    private readonly reportFailure: (code: string) => void
  ) {}

  private async initialState(): Promise<FileDialogUiState> {
    const initial = this.request.options.defaultPath ?? ''
    const directoryMode = this.request.kind === 'open'
    const initialIsDirectory =
      validPath(initial) && (await stat(initial).catch(() => null))?.isDirectory()
    const preferred = validPath(initial)
      ? initialIsDirectory || directoryMode
        ? initial
        : dirname(initial)
      : ''
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
      mode: directoryMode ? 'directory' : 'save',
      title: this.request.options.title,
      buttonLabel: this.request.options.buttonLabel,
      filename: directoryMode || initialIsDirectory ? '' : basename(initial),
      filters: this.request.options.filters ?? [],
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
          this.finish(
            this.request.kind === 'save'
              ? { canceled: true, filePath: '' }
              : { canceled: true, filePaths: [] }
          )
          return { type: 'done' }
        case 'browse':
          this.confirmation = undefined
          return { type: 'browse', location: await listLocation(action.path) }
        case 'mkdir': {
          this.confirmation = undefined
          if (
            !validPath(action.directory) ||
            typeof action.name !== 'string' ||
            !validWindowsFilename(action.name)
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
          if (this.request.kind === 'open') {
            this.closed = true
            this.finish({ canceled: false, filePaths: [resolve(action.directory)] })
            return { type: 'done' }
          }
          let filename = action.filename
          if (typeof filename !== 'string' || !validWindowsFilename(filename))
            return { type: 'error', code: 'filename' }
          const filters = this.request.options.filters ?? []
          if (
            !Number.isInteger(action.filterIndex) ||
            action.filterIndex < 0 ||
            (filters.length && action.filterIndex >= filters.length)
          )
            return { type: 'error', code: 'extension' }
          const extensions = filters[action.filterIndex]?.extensions ?? []
          if (!extname(filename) && extensions.length && !extensions.includes('*'))
            filename += `.${extensions[0]}`
          if (!validWindowsFilename(filename)) return { type: 'error', code: 'filename' }
          if (
            extensions.length &&
            !extensions.includes('*') &&
            !extensions.some((extension) =>
              filename.toLowerCase().endsWith(`.${extension.toLowerCase()}`)
            )
          )
            return { type: 'error', code: 'extension' }
          const path = join(action.directory, filename)
          const existing = await fingerprint(path)
          if (existing !== undefined) {
            const token = randomUUID()
            this.confirmation = { token, path, fingerprint: existing }
            return { type: 'confirm', filename, token }
          }
          this.closed = true
          this.finish({ canceled: false, filePath: path })
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
          this.finish({ canceled: false, filePath: pending.path })
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
