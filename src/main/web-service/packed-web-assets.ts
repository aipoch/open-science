import { open, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

type AssetRange = readonly [offset: number, length: number]
type AssetLookup = (name: string) => AssetRange | undefined

async function loadAssetIndex(root: string): Promise<AssetLookup> {
  let raw: string
  try {
    raw = await readFile(resolve(root, '../web-assets.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    try {
      await stat(resolve(root, '../web-assets.asar'))
    } catch (archiveError) {
      if ((archiveError as NodeJS.ErrnoException).code === 'ENOENT') return () => undefined
      throw archiveError
    }
    throw new Error('Missing packaged Web asset index', { cause: error })
  }
  // Match the actual document root's case sensitivity, including case-sensitive APFS/NTFS.
  const indexFile = await stat(join(root, 'index.html'), { bigint: true })
  const alternate = await stat(join(root, 'INDEX.HTML'), { bigint: true }).catch(() => undefined)
  const fold = alternate?.ino === indexFile.ino && alternate.dev === indexFile.dev
  const key = (name: string): string => (fold ? name.toLowerCase() : name)
  const entries = new Map<string, AssetRange>()
  for (const [name, offset, length] of JSON.parse(raw)) {
    if (
      typeof name !== 'string' ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      entries.has(key(name))
    ) {
      throw new Error('Invalid packaged Web asset index')
    }
    entries.set(key(name), [offset, length])
  }
  return (name) => entries.get(key(name))
}

export function createPackedWebAssetReader(
  root: string
): (file: string) => Promise<Buffer | undefined> {
  let index: Promise<AssetLookup> | undefined
  return async (file) => {
    const name = relative(root, file).split(sep).join('/')
    if (!name.toLowerCase().startsWith('assets/')) return undefined
    index ??= loadAssetIndex(root).catch((error) => {
      index = undefined
      throw error
    })
    const range = (await index)(name)
    if (!range) return undefined
    const [offset, length] = range
    const handle = await open(resolve(root, '../web-assets.asar'), 'r')
    try {
      if (offset + length > (await handle.stat()).size)
        throw new Error('Incomplete Web asset archive')
      const bytes = Buffer.alloc(length)
      let position = 0
      while (position < length) {
        const { bytesRead } = await handle.read(
          bytes,
          position,
          length - position,
          offset + position
        )
        if (!bytesRead) throw new Error('Incomplete Web asset archive')
        position += bytesRead
      }
      return bytes
    } finally {
      await handle.close()
    }
  }
}
