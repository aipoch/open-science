/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Only the reviewed repository catalog selects executable bytes. CDN metadata is never trusted.
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetch, EnvHttpProxyAgent } from 'undici'

export const root = resolve(import.meta.dirname, '..')
export const spec = JSON.parse(await readFile(join(root, 'build/native-components.json'), 'utf8'))
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const maxSize = 20 * 1024 * 1024

export function nativeFiles(target) {
  if (!spec.targets.includes(target)) throw new Error(`Unsupported native target: ${target}`)
  return Object.entries(spec.packages).flatMap(([pkg, names]) =>
    names.map((name) => ({
      package: pkg,
      name: name + (target.startsWith('win32-') && !name.endsWith('.node') ? '.exe' : '')
    }))
  )
}

export async function sourceFingerprint(directory = root) {
  const hash = createHash('sha256').update(JSON.stringify(spec))
  const lock = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8'))
  hash.update(JSON.stringify(lock.packages['node_modules/node-gyp']))
  for (const pkg of Object.keys(spec.packages)) {
    const base = join(directory, 'packages', pkg)
    const paths = [
      'binding.gyp',
      ...(await readdir(join(base, 'src'))).sort().map((p) => `src/${p}`)
    ]
    for (const path of paths) {
      const file = join(base, path)
      if (!(await lstat(file)).isFile()) throw new Error(`Native source must be a file: ${file}`)
      hash
        .update(`${pkg}/${path}\0`)
        .update((await readFile(file, 'utf8')).replaceAll('\r\n', '\n'))
        .update('\0')
    }
  }
  return hash.digest('hex')
}

export function validateNativeRelease(release, target, fingerprint) {
  const expected = nativeFiles(target)
  if (
    release?.schema !== 1 ||
    release.target !== target ||
    release.source !== fingerprint ||
    !/^[a-f0-9]{64}$/.test(release.source) ||
    release.node !== spec.node ||
    !Array.isArray(release.files) ||
    release.files.length !== expected.length ||
    release.signing !== (target.startsWith('linux-') ? 'none' : 'release')
  )
    throw new Error(
      `Missing, stale, or unsigned native release for ${target}; publish matching components first.`
    )
  for (const [index, file] of release.files.entries()) {
    const item = expected[index]
    if (
      file.package !== item.package ||
      file.name !== item.name ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0 ||
      file.size > maxSize ||
      file.url !== `${spec.cdn}/${target}/${file.sha256}/${file.name}`
    )
      throw new Error(`Invalid native component record for ${target}`)
  }
  return release
}

export async function verifiedBytes(path, expected) {
  const info = await lstat(path)
  if (!info.isFile() || info.size !== expected.size || info.size > maxSize)
    throw new Error(`Invalid native component size or file type: ${path}`)
  const bytes = await readFile(path)
  if (digest(bytes) !== expected.sha256)
    throw new Error(`Native component checksum mismatch: ${path}`)
  return bytes
}

export async function stageNativeComponents({
  directory = root,
  target = `${process.platform}-${process.arch}`,
  catalog,
  fetchImpl = fetch
} = {}) {
  nativeFiles(target)
  catalog ??= JSON.parse(
    await readFile(join(directory, 'build/native-components-lock.json'), 'utf8')
  )
  const release = validateNativeRelease(catalog[target], target, await sourceFingerprint(directory))
  const cache = join(directory, 'node_modules/.cache/native-components')
  await mkdir(cache, { recursive: true })
  const dispatcher = new EnvHttpProxyAgent()
  const prepared = []
  try {
    for (const file of release.files) {
      const destination = join(directory, 'packages', file.package, 'build/Release', file.name)
      const cached = join(cache, file.sha256)
      let bytes
      try {
        bytes = await verifiedBytes(cached, file)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        const response = await fetchImpl(file.url, {
          redirect: 'error',
          signal: AbortSignal.timeout(120_000),
          dispatcher
        })
        if (!response.ok || !response.body)
          throw new Error(`Native download failed (${response.status}): ${file.name}`)
        const chunks = []
        let size = 0
        for await (const chunk of response.body) {
          size += chunk.length
          if (size > file.size) throw new Error(`Native download exceeds pinned size: ${file.name}`)
          chunks.push(chunk)
        }
        bytes = Buffer.concat(chunks)
        if (bytes.length !== file.size || digest(bytes) !== file.sha256)
          throw new Error(`Native download checksum mismatch: ${file.name}`)
        await atomicWrite(cached, bytes, 0o600)
      }
      prepared.push({ destination, bytes })
    }
    // Verify every input before replacing any package output. Never invoke a compiler on a miss.
    for (const { destination, bytes } of prepared) await atomicWrite(destination, bytes, 0o755)
  } finally {
    await dispatcher.close()
  }
  return release
}

async function atomicWrite(path, bytes, mode) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.partial`
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await stageNativeComponents()
  console.log('Verified and staged pinned native components.')
}
