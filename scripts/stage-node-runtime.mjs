/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { x as extractTar } from 'tar'
import { unzipSync } from 'fflate'
import { fetch, EnvHttpProxyAgent } from 'undici'

const root = resolve(import.meta.dirname, '..')
export const nodeRuntime = JSON.parse(await readFile(join(root, 'build/node-runtime.json'), 'utf8'))
const archiveLimit = 100 * 1024 * 1024
export async function verifyNodeArchive(path, expected) {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path)) {
    size += chunk.length
    if (size > archiveLimit) throw new Error('Node runtime archive exceeds the download limit.')
    hash.update(chunk)
  }
  if (hash.digest('hex') !== expected) throw new Error('Node runtime archive checksum mismatch.')
}

export async function extractNodeRuntime(archive, output, platform, arch) {
  const archiveRoot = `node-v${nodeRuntime.version}-${platform === 'win32' ? 'win' : platform}-${arch}`
  const executable = platform === 'win32' ? 'node.exe' : 'bin/node'
  const entries = new Set([`${archiveRoot}/${executable}`, `${archiveRoot}/LICENSE`])
  await mkdir(output, { recursive: true })
  if (platform === 'win32') {
    const files = unzipSync(await readFile(archive), { filter: (entry) => entries.has(entry.name) })
    for (const entry of entries) {
      if (!files[entry]) throw new Error(`Node runtime is missing ${entry}.`)
      await writeFile(
        join(output, entry.endsWith('/LICENSE') ? 'LICENSE' : 'node.exe'),
        files[entry],
        { flag: 'wx' }
      )
    }
  } else {
    await extractTar({
      file: archive,
      cwd: output,
      strip: 1,
      strict: true,
      filter: (path, entry) => entries.has(path) && entry.type === 'File'
    })
    await rename(join(output, 'bin/node'), join(output, 'node'))
    await rm(join(output, 'bin'), { recursive: true })
    await chmod(join(output, 'node'), 0o755)
  }
  for (const name of [platform === 'win32' ? 'node.exe' : 'node', 'LICENSE']) {
    const info = await stat(join(output, name))
    if (!info.isFile() || info.size === 0) throw new Error(`Node runtime has an invalid ${name}.`)
  }
}

export async function stageNodeRuntime({
  platform = process.platform,
  arch = process.arch,
  output = join(root, 'out/node-runtime', `${platform}-${arch}`),
  cache = join(root, 'node_modules/.cache/node-runtime')
} = {}) {
  const source = nodeRuntime.archives[`${platform}-${arch}`]
  if (!source) throw new Error(`No pinned Node runtime for ${platform}/${arch}.`)
  await mkdir(cache, { recursive: true })
  const archive = join(cache, source.file)
  try {
    await verifyNodeArchive(archive, source.sha256)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const dispatcher = new EnvHttpProxyAgent()
    try {
      const response = await fetch(
        `https://nodejs.org/dist/v${nodeRuntime.version}/${source.file}`,
        {
          signal: AbortSignal.timeout(120_000),
          dispatcher
        }
      )
      if (!response.ok || !response.body)
        throw new Error(`Node runtime download failed (${response.status}).`)
      const temporary = `${archive}.${randomUUID()}.partial`
      try {
        const chunks = []
        let size = 0
        for await (const chunk of response.body) {
          size += chunk.length
          if (size > archiveLimit)
            throw new Error('Node runtime archive exceeds the download limit.')
          chunks.push(chunk)
        }
        await writeFile(temporary, Buffer.concat(chunks), { flag: 'wx' })
        await verifyNodeArchive(temporary, source.sha256)
        await rename(temporary, archive)
      } finally {
        await rm(temporary, { force: true })
      }
    } finally {
      await dispatcher.close()
    }
  }
  await mkdir(dirname(output), { recursive: true })
  const temporary = await mkdtemp(join(dirname(output), '.node-runtime-'))
  try {
    await extractNodeRuntime(archive, temporary, platform, arch)
    await writeFile(
      join(temporary, 'version.json'),
      JSON.stringify({ version: nodeRuntime.version, platform, arch, sha256: source.sha256 }) + '\n'
    )
    await rm(output, { recursive: true, force: true })
    await rename(temporary, output)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  return output
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [platform = process.platform, arch = process.arch] = process.argv.slice(2)
  console.log(await stageNodeRuntime({ platform, arch }))
}
