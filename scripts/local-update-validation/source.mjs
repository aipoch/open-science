/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  symlink,
  writeFile
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const exec = promisify(execFile)
const git = async (root, args) =>
  (await exec('git', ['--no-optional-locks', '-C', root, ...args], { maxBuffer: 64 * 1024 * 1024 }))
    .stdout
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const excluded = (path) => path.split('/').some((part) => ['.git', 'node_modules'].includes(part))

async function paths(root) {
  const names = (await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter(Boolean)
  return [...new Set(names)].filter((name) => !excluded(name)).sort()
}

async function inspect(root, names) {
  const records = []
  for (const name of names) {
    const path = resolve(root, name)
    if (relative(root, path).startsWith(`..${sep}`) || isAbsolute(relative(root, path)))
      throw new Error(`Source path escapes workspace: ${name}`)
    let info
    try {
      info = await lstat(path)
    } catch (error) {
      if (error.code === 'ENOENT') continue // Tracked deletion is part of the captured working tree.
      throw error
    }
    if (info.isSymbolicLink()) {
      const target = await readlink(path)
      const targetPath = relative(root, resolve(dirname(path), target))
      if (isAbsolute(target) || targetPath === '..' || targetPath.startsWith(`..${sep}`))
        throw new Error(`Source symlink leaves snapshot: ${name}`)
      records.push({ path: name, kind: 'symlink', target })
    } else if (info.isFile()) {
      records.push({
        path: name,
        kind: 'file',
        executable: !!(info.mode & 0o111),
        sha256: hash(await readFile(path))
      })
    } else {
      throw new Error(`Unsupported source entry (initialize submodules explicitly): ${name}`)
    }
  }
  return records
}

// No Git checkout, index refresh, ignored-file scan, dependency/output copy, or original-tree write.
// Two inventories + two content comparisons detect edits during capture; later edits are irrelevant.
export async function captureSource(workspace, destination) {
  const root = resolve(workspace)
  const commit = (await git(root, ['rev-parse', 'HEAD'])).trim()
  const firstNames = await paths(root)
  const first = await inspect(root, firstNames)
  await mkdir(destination, { recursive: false })
  for (const record of first) {
    const output = join(destination, record.path)
    await mkdir(dirname(output), { recursive: true })
    if (record.kind === 'symlink') await symlink(record.target, output)
    else {
      await copyFile(join(root, record.path), output)
      await chmod(output, record.executable ? 0o755 : 0o644)
    }
  }
  const captured = await inspect(destination, firstNames)
  const lastNames = await paths(root)
  const last = await inspect(root, lastNames)
  if (
    JSON.stringify(first) !== JSON.stringify(captured) ||
    JSON.stringify(first) !== JSON.stringify(last)
  )
    throw new Error('Workspace changed while capturing source. Retry after edits have finished.')
  const id = hash(JSON.stringify(first))
  const receipt = {
    schema: 1,
    commit,
    snapshotId: id,
    files: first,
    capturedAt: new Date().toISOString()
  }
  await writeFile(
    join(dirname(destination), 'source.json'),
    `${JSON.stringify(receipt, null, 2)}\n`
  )
  return receipt
}

export async function setBuildVersion(directory, version) {
  for (const filename of ['package.json', 'package-lock.json']) {
    const path = join(directory, filename)
    const value = JSON.parse(await readFile(path, 'utf8'))
    value.version = version
    if (value.packages?.['']) value.packages[''].version = version
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
  }
}

export function validateVersions(a, b) {
  const parse = (version) => {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
      throw new Error(`Expected stable x.y.z version, received ${version}`)
    const parts = version.split('.').map(Number)
    if (parts.some((part) => !Number.isSafeInteger(part)))
      throw new Error('Version component is too large.')
    return parts
  }
  const first = parse(a)
  if (first.every((part) => part === 0))
    throw new Error('A must be greater than 0.0.0 so lower-version is a distinct scenario.')
  const second = parse(b)
  const difference = second.findIndex((part, i) => part !== first[i])
  if (difference === -1 || second[difference] <= first[difference])
    throw new Error('B must be newer than A.')
}
