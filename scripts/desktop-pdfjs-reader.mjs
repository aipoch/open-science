/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { open } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function withDesktopCMaps(getDocument, ranges, entryUrl) {
  const directory = new URL('../../cmaps/', entryUrl)
  const directoryPath = fileURLToPath(directory)
  const archive = new URL('character-maps.bin', directory)
  const isDesktopCMapDirectory = (value) => {
    const matchesPath = (candidate) => relative(resolve(directoryPath), resolve(candidate)) === ''
    if (value === directory.href) return true
    if (value.startsWith('file:')) {
      try {
        return matchesPath(fileURLToPath(new URL(value)))
      } catch {
        return false
      }
    }
    return isAbsolute(value) && matchesPath(value)
  }

  class PackedCMapReader {
    async fetch({ name }) {
      const range = ranges.get(name)
      if (!range) throw new Error(`Unknown PDF.js character map: ${name}`)
      const [offset, length] = range
      const bytes = new Uint8Array(length)
      const file = await open(archive, 'r')
      try {
        let read = 0
        while (read < length) {
          const { bytesRead } = await file.read(bytes, read, length - read, offset + read)
          if (!bytesRead) throw new Error(`Incomplete PDF.js character map: ${name}`)
          read += bytesRead
        }
        return { cMapData: bytes, isCompressed: true }
      } finally {
        await file.close()
      }
    }
  }

  return function loadDocument(source) {
    const url = source?.cMapUrl
    if (
      typeof url === 'string' &&
      !source.CMapReaderFactory &&
      source.cMapPacked !== false &&
      source.useWorkerFetch !== true &&
      isDesktopCMapDirectory(url)
    ) {
      return getDocument({ ...source, CMapReaderFactory: PackedCMapReader, useWorkerFetch: false })
    }
    return getDocument(source)
  }
}
