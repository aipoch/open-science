/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { compress, init as initZstd } from '@bokuweb/zstd-wasm'
import { c as createTar } from 'tar'
import { writeFile } from 'node:fs/promises'

/** @type {Promise<void> | undefined} */
let zstdReady

/** @returns {Promise<void>} */
const ensureZstd = () => {
  zstdReady ??= initZstd()
  return zstdReady
}

/** @param {string} sourceDir @param {string} archivePath @returns {Promise<void>} */
export const createPackArchive = async (sourceDir, archivePath) => {
  await ensureZstd()
  const stream = createTar({ cwd: sourceDir, portable: true }, ['.'])
  const chunks = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  await writeFile(archivePath, Buffer.from(compress(Buffer.concat(chunks), 10)))
}
