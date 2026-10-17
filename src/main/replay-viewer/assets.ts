import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp'
}

const MAX_BYTES = 16 * 1024 * 1024
const unavailable = (error: unknown): boolean =>
  ['ENOENT', 'ENOTDIR', 'ELOOP', 'ENXIO', 'EISDIR'].includes(
    (error as NodeJS.ErrnoException).code ?? ''
  )
const sameIdentity = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino
const unchangedFile = (a: BigIntStats, b: BigIntStats): boolean =>
  sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs

/** The browser bundle is unpacked so native filesystem checks apply in packaged Electron too. */
export const resolveReplayViewerAssetRoot = (mainDirectory = __dirname): string =>
  resolve(
    mainDirectory
      .split(sep)
      .map((part) => (part === 'app.asar' ? 'app.asar.unpacked' : part))
      .join(sep),
    '../replay-viewer'
  )

export const createReplayViewerAssetReader =
  (root = resolveReplayViewerAssetRoot()) =>
  async (path: string): Promise<{ body: Uint8Array; mimeType: string } | undefined> => {
    if (
      path.length > 4096 ||
      !(
        path === 'index.html' ||
        path === 'favicon.ico' ||
        /^assets\/[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(path)
      ) ||
      path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      return undefined
    const mimeType = types[extname(path)]
    if (!mimeType) return undefined
    let file
    try {
      const rootStat = await lstat(root, { bigint: true })
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return undefined
      const canonicalRoot = await realpath(root)
      const directories: { path: string; stat: BigIntStats }[] = [
        { path: canonicalRoot, stat: rootStat }
      ]
      const parts = path.split('/')
      let directory = canonicalRoot
      for (const part of parts.slice(0, -1)) {
        directory = join(directory, part)
        const stat = await lstat(directory, { bigint: true })
        if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined
        directories.push({ path: directory, stat })
      }
      const filename = join(canonicalRoot, path)
      const before = await lstat(filename, { bigint: true })
      if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_BYTES))
        return undefined
      file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const opened = await file.stat({ bigint: true })
      if (!opened.isFile() || !unchangedFile(before, opened)) return undefined

      const directoriesIntact = async (): Promise<boolean> => {
        if ((await realpath(root)) !== canonicalRoot) return false
        if (!sameIdentity(rootStat, await lstat(root, { bigint: true }))) return false
        for (const expected of directories) {
          const current = await lstat(expected.path, { bigint: true })
          if (
            !current.isDirectory() ||
            current.isSymbolicLink() ||
            !sameIdentity(expected.stat, current)
          )
            return false
        }
        return true
      }
      if (!(await directoriesIntact())) return undefined
      // Never let readFile allocate an unbounded buffer if a file grows after the size check.
      const chunks: Buffer[] = []
      let size = 0
      while (size <= MAX_BYTES) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_BYTES + 1 - size))
        const { bytesRead } = await file.read(chunk, 0, chunk.length, size)
        if (!bytesRead) break
        chunks.push(chunk.subarray(0, bytesRead))
        size += bytesRead
      }
      if (
        size > MAX_BYTES ||
        !(await directoriesIntact()) ||
        !unchangedFile(opened, await file.stat({ bigint: true })) ||
        !unchangedFile(opened, await lstat(filename, { bigint: true }))
      )
        return undefined
      return { body: Buffer.concat(chunks, size), mimeType }
    } catch (error) {
      if (unavailable(error)) return undefined
      throw error
    } finally {
      await file?.close()
    }
  }
