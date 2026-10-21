/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, mkdir, open, realpath, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileIdentity } from './build.mjs'

/** A real ZIP containing only updater metadata: installation requires a separately supplied payload. */
export async function createUpdaterOnlyArtifact(directory, version, arch, snapshotId) {
  await mkdir(directory, { recursive: true })
  const name = `aipoch-open-science-${version}-mac-${arch}-updater-only.zip`
  const metadata = 'updater-payload-reference.json'
  await writeFile(
    join(directory, metadata),
    JSON.stringify(
      {
        schema: 1,
        version,
        arch,
        snapshotId,
        contract: 'local-validation-updater-only',
        requires: `aipoch-open-science-${version}-mac-${arch}.zip`,
        standalone: false,
        description: 'Updater metadata only. Required application payload is absent.'
      },
      null,
      2
    )
  )
  await promisify(execFile)('/usr/bin/zip', ['-q', name, metadata], { cwd: directory })
  return {
    version,
    snapshotId,
    directory,
    files: [{ name, ...(await fileIdentity(join(directory, name))) }]
  }
}

/** Mutate only the recorded completed artifact, never a path supplied by the renderer/user. */
export async function invalidateDownloadedArtifact(config, verified, mutation) {
  if (!['delete', 'corrupt'].includes(mutation)) throw new Error('Unknown cache mutation.')
  const path = verified.localPath
  const rel = relative(config.updateCacheRoot, path)
  if (
    !rel ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel) ||
    (await realpath(path)) !== path
  )
    throw new Error("Cache mutation must target only this scenario's recorded download.")
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    throw new Error('Cache mutation requires an exclusively owned regular artifact.')
  const checksum = (await fileIdentity(path)).sha512
  if (checksum !== verified.artifactSha512) throw new Error('Cache artifact already changed.')
  if (mutation === 'delete') await unlink(path)
  else {
    const file = await open(path, 'r+')
    try {
      const byte = Buffer.alloc(1)
      await file.read(byte, 0, 1, 0)
      byte[0] ^= 0xff
      await file.write(byte, 0, 1, 0)
      await file.sync()
    } finally {
      await file.close()
    }
  }
  return { path, mutation, priorSha512: checksum, priorDevice: before.dev, priorInode: before.ino }
}
