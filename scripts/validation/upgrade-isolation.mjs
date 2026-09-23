/* eslint-disable @typescript-eslint/explicit-function-return-type -- standalone JavaScript validation helper. */
import assert from 'node:assert/strict'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

export const containsParentTraversal = (path) => path.split(/[\\/]+/).includes('..')

// Resolve the nearest existing ancestor, including symlinks, before appending absent children.
const canonicalPath = async (candidate) => {
  try {
    await lstat(candidate)
    return await realpath(candidate)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    // A dangling symlink is not a safely absent directory.
    const entry = await lstat(candidate).catch(() => undefined)
    assert.ok(!entry?.isSymbolicLink(), `Dangling symlink is not allowed: ${candidate}`)
    const parent = dirname(candidate)
    assert.notEqual(parent, candidate)
    // Keep the raw parent until realpath has traversed symlinks. Resolving `link/..`
    // lexically first can hide that `link` points outside the disposable root.
    return join(await canonicalPath(parent), basename(candidate))
  }
}

export const isWithin = (root, path, pathOperations = { relative, isAbsolute, sep }) => {
  const suffix = pathOperations.relative(root, path)
  return (
    suffix === '' ||
    (!pathOperations.isAbsolute(suffix) &&
      suffix !== '..' &&
      !suffix.startsWith(`..${pathOperations.sep}`))
  )
}

export const assertUpgradeIsolation = async ({ root, repository, suffix }) => {
  assert.ok(isAbsolute(root), 'Use an absolute disposable root')
  assert.ok(!containsParentTraversal(root), 'Parent traversal is not allowed in the upgrade root')
  assert.ok(
    !isAbsolute(suffix) && !containsParentTraversal(suffix),
    'Expected root suffix must be relative and contain no parent traversal'
  )
  const actualRoot = await canonicalPath(root)
  const temporaryRoot = await realpath(tmpdir())
  assert.ok(
    actualRoot !== temporaryRoot && isWithin(temporaryRoot, actualRoot),
    'Upgrade root must be a child of the system temporary directory'
  )
  const userHome = await canonicalPath(homedir())
  // Windows usually puts os.tmpdir() below the user home. A child of that temporary
  // directory is safe, but the root must never be home or contain home.
  assert.ok(
    actualRoot !== userHome && !isWithin(actualRoot, userHome),
    'Upgrade root must not be or contain home'
  )
  const repositoryRoot = await canonicalPath(repository)
  assert.ok(
    !isWithin(actualRoot, repositoryRoot) && !isWithin(repositoryRoot, actualRoot),
    'Upgrade root must not overlap the repository'
  )
  const check = async (candidate) => {
    assert.ok(isAbsolute(candidate), `Path must be absolute: ${candidate}`)
    assert.ok(!containsParentTraversal(candidate), `Parent traversal is not allowed: ${candidate}`)
    assert.ok(
      isWithin(actualRoot, await canonicalPath(candidate)),
      `Path escapes disposable root: ${candidate}`
    )
  }
  for (const path of [
    'config',
    'config/settings.json',
    'home',
    'profile',
    'logs',
    'relocated',
    'isolate.cjs',
    'evidence.json',
    'migration.json',
    suffix
  ]) {
    await check(join(root, path))
  }
  // Recovery may replace settings before the app reads dataRoot. This runner does not
  // exercise crash recovery, so reject transaction remnants rather than trusting them.
  const entries = await readdir(join(root, 'config')).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  assert.ok(
    !entries.some((name) => name.startsWith('settings.json.') || name === 'settings.json~'),
    'Settings recovery remnants are not allowed in an upgrade validation root'
  )
  let settings
  try {
    settings = JSON.parse(await readFile(join(root, 'config/settings.json'), 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (settings?.dataRoot != null && settings.dataRoot !== '') {
    assert.equal(typeof settings.dataRoot, 'string', 'Saved dataRoot must be an absolute path')
    await check(settings.dataRoot)
  }
}
