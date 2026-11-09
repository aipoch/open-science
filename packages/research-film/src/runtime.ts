import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, lstat, writeFile, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import assets from './runtime-assets.json' with { type: 'json' }

export type NarrationRuntimeAsset = {
  package: string
  version: string
  path: string
  file: string
  url: string
  size: number
  sha256: string
  target?: string
}

export const narrationRuntimeAssets = (
  target = `${process.platform}/${process.arch}`
): NarrationRuntimeAsset[] => {
  if (!assets.some((asset) => asset.target === target))
    throw new Error(`Research narration is not supported on ${target}`)
  return assets.filter((asset) => !asset.target || asset.target === target)
}

/** Recreate only the pinned Node entry points in the job-owned directory; never run npm scripts. */
export async function prepareNarrationRuntime(
  modelDirectory: string,
  directory: string
): Promise<NodeJS.Require> {
  await mkdir(directory, { recursive: false })
  for (const asset of narrationRuntimeAssets()) {
    const source = join(modelDirectory, asset.file)
    const info = await lstat(source).catch(() => undefined)
    if (!info?.isFile() || info.isSymbolicLink() || info.size !== asset.size)
      throw new Error('Install or update Research narration in Settings before generating.')
    const bytes = await readFile(source)
    if (
      bytes.length !== asset.size ||
      createHash('sha256').update(bytes).digest('hex') !== asset.sha256
    )
      throw new Error(`Research narration runtime checksum failed: ${asset.file}`)
    const destination = join(directory, 'node_modules', asset.package, asset.path)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, bytes, { flag: 'wx' })
  }
  for (const [name, main] of Object.entries({
    'kokoro-js': 'dist/kokoro.cjs',
    phonemizer: 'dist/phonemizer.cjs',
    '@huggingface/transformers': 'dist/transformers.node.cjs',
    'onnxruntime-common': 'dist/cjs/index.js',
    'onnxruntime-node': 'dist/index.js'
  })) {
    await writeFile(
      join(directory, 'node_modules', name, 'package.json'),
      JSON.stringify({ name, main, type: 'commonjs' }),
      { flag: 'wx' }
    )
  }
  if (process.platform === 'linux') {
    await symlink(
      'libonnxruntime.so.1.21.0',
      join(
        directory,
        'node_modules/onnxruntime-node/bin/napi-v3/linux',
        process.arch,
        'libonnxruntime.so.1'
      )
    )
  }
  // Transformers imports sharp eagerly. Reuse the app's existing copy instead of downloading another.
  const sharpDirectory = join(directory, 'node_modules/sharp')
  await mkdir(sharpDirectory)
  await writeFile(
    join(sharpDirectory, 'index.js'),
    `module.exports = require(${JSON.stringify(createRequire(import.meta.url).resolve('sharp'))});`,
    { flag: 'wx' }
  )
  return createRequire(join(directory, 'entry.cjs'))
}
