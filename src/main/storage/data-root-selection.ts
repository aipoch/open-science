import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DATA_ROOT_SELECTION_CHANGED, type DataRootSelection } from '../../shared/storage'
import { dataRootForPicked, samePath } from '../storage-root'
import { directoryHasFiles } from './location-evidence'
import { MANAGED_WORKSPACE_OWNERSHIP_DIR } from './managed-workspace-ownership-dir'

export const dataRootDirectoryIdentity = (target: string): string => {
  const path = realpathSync(target)
  const entry = lstatSync(target)
  const directory = lstatSync(path)
  return JSON.stringify([
    path,
    entry.dev,
    entry.ino,
    directory.dev,
    directory.ino,
    directory.birthtimeMs
  ])
}

// Observe directory identity and ownership evidence, not the contents of research files. This is
// synchronous so settings can recheck it immediately before publishing the pointer.
export const dataRootIdentity = (target: string): string => {
  const identity = (path: string): unknown => {
    try {
      const info = lstatSync(path)
      return [
        realpathSync(path),
        info.dev,
        info.ino,
        info.birthtimeMs,
        info.isSymbolicLink() ? dataRootDirectoryIdentity(path) : undefined,
        info.isDirectory() ? directoryHasFiles(path) : [info.size, info.mtimeMs]
      ]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  const entries = (path: string): string[] => {
    try {
      return readdirSync(path)
        .filter(
          (name) =>
            !['.DS_Store', 'desktop.ini'].includes(name) &&
            !name.startsWith('.open-science-write-test-')
        )
        .sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
  const parent = lstatSync(dirname(target))
  const receipts = join(target, 'workspaces', MANAGED_WORKSPACE_OWNERSHIP_DIR)
  return createHash('sha256')
    .update(
      JSON.stringify([
        [realpathSync(dirname(target)), parent.dev, parent.ino],
        identity(target),
        entries(target).map((name) => [name, identity(join(target, name))]),
        entries(receipts).map((name) => [
          name,
          readFileSync(join(receipts, name), 'utf8'),
          name.endsWith('.json') ? identity(join(target, 'workspaces', name.slice(0, -5))) : null
        ])
      ])
    )
    .digest('hex')
}

export const assertDataRootSelection = (selection: DataRootSelection): void => {
  if (
    !samePath(dataRootForPicked(selection.pickedPath), selection.dataRoot) ||
    dataRootIdentity(selection.dataRoot) !== selection.identity
  ) {
    throw new Error(DATA_ROOT_SELECTION_CHANGED)
  }
}
