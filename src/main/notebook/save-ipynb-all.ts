import { link, mkdtemp, readFile as fsReadFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import type { ExportNotebookAllResult } from '../../shared/notebook'

export type SaveIpynbAllTarget = {
  kernel: 'python' | 'r'
  name: string
  data: string
  filePath: string
}

export const findExistingTargets = (filePaths: string[]): string[] =>
  filePaths.filter((path) => existsSync(path))

export type FsDeps = {
  writeFile: (filePath: string, data: string) => Promise<void>
  publishNoReplace: (src: string, dest: string) => Promise<void>
  publishReplace: (src: string, dest: string) => Promise<void>
  readFileOrNull: (filePath: string) => Promise<string | null>
  rmRmdir: (dirPath: string) => Promise<void>
  mkdtemp: (prefix: string) => Promise<string>
}

// Result of a multi-file export. On partial failure, already-published files are LEFT IN PLACE
// (rolling back user-visible paths races with other processes). The caller surfaces which files
// succeeded and which failed so the user knows the exact state.
export type WriteResult =
  | { ok: true; published: string[] }
  | { ok: false; published: string[]; failedTarget: string; error: Error }

// Writes every target into a private staging directory, then publishes each file atomically.
//
// New files use link(2) (no-replace). Confirmed files use rename(2) (replace).
//
// Partial failure policy: if file N fails after 1..N-1 succeeded, the published files stay and
// the result reports { ok: false, published, failedTarget }. No rollback of user-visible paths.
export const writeNotebooksWithCleanup = async (
  targets: SaveIpynbAllTarget[],
  fsDeps: FsDeps,
  confirmedPaths: Set<string> = new Set()
): Promise<WriteResult> => {
  if (targets.length === 0) return { ok: true, published: [] }

  const stagingDir = await fsDeps.mkdtemp(join(targets[0]!.filePath, '..', '.open-science-export-'))

  const staged: Array<{ target: SaveIpynbAllTarget; stagingPath: string }> = []
  const published: string[] = []
  let currentTarget = ''

  try {
    for (const target of targets) {
      currentTarget = target.name
      const stagingPath = join(stagingDir, `${target.name}.${randomBytes(4).toString('hex')}`)
      await fsDeps.writeFile(stagingPath, target.data)
      staged.push({ target, stagingPath })
    }

    for (const entry of staged) {
      currentTarget = entry.target.name
      const isConfirmed = confirmedPaths.has(entry.target.filePath)
      if (isConfirmed) {
        await fsDeps.readFileOrNull(entry.target.filePath)
        await fsDeps.publishReplace(entry.stagingPath, entry.target.filePath)
      } else {
        await fsDeps.publishNoReplace(entry.stagingPath, entry.target.filePath)
      }
      published.push(entry.target.filePath)
    }
  } catch (error) {
    await fsDeps.rmRmdir(stagingDir).catch(() => {})
    return {
      ok: false,
      published,
      failedTarget: currentTarget || 'unknown',
      error: error instanceof Error ? error : new Error(String(error))
    }
  }

  await fsDeps.rmRmdir(stagingDir).catch(() => {})
  return { ok: true, published }
}

export type ElectronSurface = {
  app: { getPath: (name: string) => string }
  dialog: {
    showOpenDialog: (options: {
      title: string
      defaultPath: string
      properties: string[]
    }) => Promise<{ canceled: boolean; filePaths: string[] }>
    showMessageBox: (options: {
      type?: 'question' | 'info' | 'warning' | 'error'
      title: string
      message: string
      detail?: string
      buttons: string[]
      defaultId?: number
      cancelId?: number
    }) => Promise<{ response: number }>
  }
}

type FsCheck = (path: string) => boolean

export type SaveIpynbAllDeps = {
  electron: ElectronSurface
  fsCheck: FsCheck
  fsOps: FsDeps
}

export const resolveTargets = (
  directory: string,
  files: Array<{ kernel: 'python' | 'r'; name: string; data: string }>
): SaveIpynbAllTarget[] =>
  files.map((file) => ({
    kernel: file.kernel,
    name: file.name,
    data: file.data,
    filePath: join(directory, file.name)
  }))

const targetFor = (filePath: string, targets: SaveIpynbAllTarget[]): SaveIpynbAllTarget => {
  const match = targets.find((target) => target.filePath === filePath)
  if (!match) throw new Error(`Internal error: no target for written path ${filePath}`)
  return match
}

export const saveIpynbAll = async (
  files: Array<{ kernel: 'python' | 'r'; name: string; data: string }>,
  deps?: SaveIpynbAllDeps
): Promise<ExportNotebookAllResult> => {
  if (files.length === 0) return { saved: false }

  const resolvedDeps: SaveIpynbAllDeps =
    deps ??
    ({
      electron: (await import('electron')) as unknown as ElectronSurface,
      fsCheck: existsSync,
      fsOps: {
        writeFile: (p, d) => writeFile(p, d, 'utf8'),
        publishNoReplace: async (src, dest) => {
          await link(src, dest)
        },
        publishReplace: async (src, dest) => {
          await rename(src, dest)
        },
        readFileOrNull: async (p) => {
          try {
            return await fsReadFile(p, 'utf8')
          } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
            throw error
          }
        },
        rmRmdir: (p) => rm(p, { recursive: true, force: true }),
        mkdtemp
      }
    } satisfies SaveIpynbAllDeps)

  const { canceled, filePaths } = await resolvedDeps.electron.dialog.showOpenDialog({
    title: 'Export notebooks by kernel',
    defaultPath: resolvedDeps.electron.app.getPath('downloads'),
    properties: ['openDirectory', 'createDirectory']
  })
  const directory = filePaths[0]
  if (canceled || !directory) return { saved: false }

  const targets = resolveTargets(directory, files)
  const conflicts = targets.filter((target) => resolvedDeps.fsCheck(target.filePath))

  if (conflicts.length > 0) {
    const listing = conflicts.map((c) => c.name).join(', ')
    const { response } = await resolvedDeps.electron.dialog.showMessageBox({
      type: 'question',
      title: 'Overwrite existing notebooks?',
      message: `${conflicts.length} notebook${conflicts.length === 1 ? '' : 's'} already exist in the chosen directory.`,
      detail: listing,
      buttons: ['Overwrite', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    })
    if (response !== 0) return { saved: false }
  }

  const confirmedPaths = new Set(conflicts.map((c) => c.filePath))
  const result = await writeNotebooksWithCleanup(targets, resolvedDeps.fsOps, confirmedPaths)

  if (!result.ok) {
    throw new Error(
      `Export incomplete: ${result.published.length} of ${targets.length} notebooks saved. ` +
        `Failed: ${result.failedTarget}. ${result.error.message}`
    )
  }

  const writtenByPath = new Map(result.published.map((path) => [path, targetFor(path, targets)]))
  const exportResult: ExportNotebookAllResult = {
    saved: true,
    directory,
    files: result.published.map((filePath) => ({
      kernel: writtenByPath.get(filePath)!.kernel,
      filePath
    }))
  }
  return exportResult
}
