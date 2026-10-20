/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// An AppImage mount belongs to the foreground CLI invocation. A detached server must never read
// native libraries/resources from that disappearing mount. Retain only this immutable, hashed
// installation payload in the user's cache; business settings and secrets stay in their usual roots.
export async function stageAppImageCli(image, backend, nodeRuntime, cache) {
  if (!isAbsolute(image)) throw new Error('Expected an absolute AppImage path.')
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(image)) digest.update(bytes)
  const identity = digest.digest('hex')
  await mkdir(cache, { recursive: true, mode: 0o700 })
  const info = await lstat(cache)
  if (
    !info.isDirectory() ||
    (process.platform !== 'win32' && (info.mode & 0o022) !== 0) ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error('AppImage CLI cache must be a directory owned by the current user.')
  const destination = join(cache, identity)
  const marker = JSON.stringify({ image: identity })
  const valid = async () => {
    try {
      const info = await lstat(destination)
      return (
        info.isDirectory() &&
        (process.platform === 'win32' || (info.mode & 0o022) === 0) &&
        (!process.getuid || info.uid === process.getuid()) &&
        (await readFile(join(destination, 'complete.json'), 'utf8')) === marker
      )
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
  }
  if (await valid()) return destination
  const temporary = join(cache, `.${identity}-${randomUUID()}`)
  await mkdir(temporary, { mode: 0o700 })
  try {
    await cp(backend, join(temporary, 'backend'), { recursive: true, dereference: true })
    await cp(nodeRuntime, join(temporary, 'node-runtime'), { recursive: true, dereference: true })
    await writeFile(join(temporary, 'complete.json'), marker, { flag: 'wx', mode: 0o600 })
    try {
      await rename(temporary, destination)
    } catch (error) {
      const exists =
        ['EEXIST', 'ENOTEMPTY'].includes(error.code) ||
        (process.platform === 'win32' && error.code === 'EPERM')
      if (!exists || !(await valid())) throw error
    }
    return destination
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function main() {
  const backend = dirname(fileURLToPath(import.meta.url))
  const payload = await stageAppImageCli(
    process.argv[2],
    backend,
    join(backend, '../node-runtime'),
    join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'open-science', 'appimage-cli')
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(
    join(payload, 'node-runtime/node'),
    [join(payload, 'backend/cli.mjs'), ...process.argv.slice(3)],
    { env, stdio: 'inherit' }
  )
  child.once('error', (error) => {
    console.error(error.message)
    process.exitCode = 1
  })
  child.once('exit', (code) => {
    process.exitCode = code ?? 1
  })
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  await main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
