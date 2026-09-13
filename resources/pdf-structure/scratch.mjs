/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { lstat, readdir, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const names = {
  '': /^(structure(?:\.pending)?\.json)$/,
  geometry: /^(probe\.json|page-\d+(?:-candidates)?\.png)$/,
  inference: /^(onnx-probe\.json|page-\d+-detected\.png|page-\d+-table-\d+\.(?:png|tsv))$/,
  thumbnails: /^(?:p\d+-(?:figure|algorithm)-\d+|page-\d+-table-\d+)\.png$/
}

// Only paths produced by this extractor are owned. Unexpected entries remain a cleanup barrier.
export async function inspectScratch(root, remove = false) {
  let bytes = 0
  const visit = async (directory, kind) => {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Unsafe PDF scratch directory.')
    for (const name of await readdir(directory)) {
      const path = join(directory, name)
      const entry = await lstat(path)
      if (
        kind === '' &&
        ['geometry', 'inference', 'thumbnails'].includes(name) &&
        entry.isDirectory() &&
        !entry.isSymbolicLink()
      ) {
        await visit(path, name)
      } else if (entry.isFile() && !entry.isSymbolicLink() && names[kind].test(name)) {
        bytes += entry.size
        if (remove) await unlink(path)
      } else throw new Error('Unexpected PDF scratch entry retained.')
    }
    if (remove) await rmdir(directory)
  }
  try {
    await visit(root, '')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return bytes
}
