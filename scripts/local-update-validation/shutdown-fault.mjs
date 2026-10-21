/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { link, lstat, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

const inside = (root, path) => {
  const rel = relative(root, path)
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
async function canonicalDirectory(path) {
  if (!(await lstat(path)).isDirectory() || (await realpath(path)) !== path)
    throw new Error('Shutdown fault resources require canonical directories without symlinks.')
}

// The source owns only the extra directory entry. It never writes, replaces, or unlinks the
// application's lock file. The production stop proof encounters a real unsafe nlink count.
export async function createShutdownFault({ runRoot, configRoot, resourceRoot }, record) {
  await canonicalDirectory(runRoot)
  await canonicalDirectory(configRoot)
  await canonicalDirectory(resourceRoot)
  if (
    !inside(runRoot, configRoot) ||
    !inside(runRoot, resourceRoot) ||
    inside(configRoot, resourceRoot) ||
    inside(resourceRoot, configRoot) ||
    resourceRoot === configRoot
  )
    throw new Error('The update source must own an independent resource directory in this run.')
  const lockPath = join(configRoot, '.open-science-runtime.sqlite')
  const linkPath = join(resourceRoot, 'runtime-lock-obstruction.sqlite')
  let identity
  let triggered = false
  let active = false
  let pending = Promise.resolve()
  const exclusive = (operation) => {
    const result = pending.then(operation)
    pending = result.catch(() => {})
    return result
  }
  return {
    get active() {
      return active
    },
    trigger() {
      return exclusive(async () => {
        if (triggered) return
        const original = await lstat(lockPath)
        if (
          !original.isFile() ||
          original.isSymbolicLink() ||
          original.nlink !== 1 ||
          (await realpath(lockPath)) !== lockPath
        )
          throw new Error('Cannot inject fault into an unexpected runtime lock.')
        await link(lockPath, linkPath)
        active = true
        identity = { dev: original.dev, ino: original.ino }
        const current = await lstat(lockPath)
        const owned = await lstat(linkPath)
        if (
          current.dev !== identity.dev ||
          current.ino !== identity.ino ||
          owned.dev !== identity.dev ||
          owned.ino !== identity.ino ||
          current.nlink !== 2 ||
          owned.nlink !== 2
        )
          throw new Error('Shutdown fault link identity changed during preparation.')
        triggered = true
        await record({
          type: 'fault-triggered',
          fault: 'shutdown-failure',
          mechanism: 'runtime-lock-hardlink',
          lockPath,
          linkPath,
          ...identity,
          nlink: current.nlink
        })
      })
    },
    release(reason = 'user-request') {
      return exclusive(async () => {
        if (!active) return
        const original = await lstat(lockPath)
        const owned = await lstat(linkPath)
        if (
          !original.isFile() ||
          original.isSymbolicLink() ||
          !owned.isFile() ||
          owned.isSymbolicLink() ||
          original.dev !== identity.dev ||
          original.ino !== identity.ino ||
          owned.dev !== identity.dev ||
          owned.ino !== identity.ino ||
          (await realpath(linkPath)) !== linkPath
        )
          throw new Error('Refusing to remove a fault resource whose original identity changed.')
        await unlink(linkPath) // Always this source-owned link; never lockPath.
        active = false
        const current = await lstat(lockPath)
        await record({
          type: 'fault-released',
          fault: 'shutdown-failure',
          reason,
          lockPath,
          linkPath,
          ...identity,
          nlink: current.nlink
        })
        if (current.nlink !== 1)
          throw new Error('Runtime lock still has unexpected links after source cleanup.')
      })
    }
  }
}
