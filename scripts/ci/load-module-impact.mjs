/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const moduleImpactRegistrationPath = 'scripts/ci/module-impact.json'
const shardDirectory = 'scripts/ci/module-impact/'

export function isModuleImpactRegistrationPath(path) {
  return (
    path === moduleImpactRegistrationPath ||
    path === shardDirectory.slice(0, -1) ||
    path.startsWith(shardDirectory)
  )
}

function assembleManifest(rootText, shards) {
  const manifest = JSON.parse(rootText)
  if (!manifest || Array.isArray(manifest) || manifest.schemaVersion !== 1) {
    throw new Error('Module-impact manifest schemaVersion must be 1')
  }
  if (Object.keys(manifest).some((key) => !['schemaVersion', 'modules'].includes(key))) {
    throw new Error('Unsupported module-impact manifest metadata')
  }
  if (Object.hasOwn(manifest, 'modules')) {
    if (shards.length > 0) throw new Error('Module-impact manifest mixes inline modules and shards')
    if (
      !manifest.modules ||
      Array.isArray(manifest.modules) ||
      typeof manifest.modules !== 'object' ||
      Object.keys(manifest.modules).length === 0
    ) {
      throw new Error('Module-impact manifest must declare modules')
    }
    return manifest
  }
  if (shards.length === 0) throw new Error('Module-impact manifest must declare modules')
  const modules = Object.fromEntries(
    shards
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map(({ path, read }) => {
        const match = /^scripts\/ci\/module-impact\/([a-z][a-z0-9_]*)\.json$/.exec(path)
        if (!match || match[0] !== path)
          throw new Error(`Invalid module-impact shard path: ${path}`)
        const module = JSON.parse(read())
        if (!module || typeof module !== 'object' || Array.isArray(module)) {
          throw new Error(`Module-impact shard must contain one module object: ${path}`)
        }
        return [match[1], module]
      })
  )
  return { ...manifest, modules }
}

export function loadModuleImpactManifest(
  manifestPath = new URL('./module-impact.json', import.meta.url)
) {
  const path = manifestPath instanceof URL ? fileURLToPath(manifestPath) : manifestPath
  if (!lstatSync(path).isFile()) throw new Error('Module-impact manifest must be a regular file')
  const directory = join(dirname(path), 'module-impact')
  let entries = []
  try {
    if (!lstatSync(directory).isDirectory())
      throw new Error('Module-impact shards must be a regular directory')
    entries = readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const shards = entries.map((entry) => {
    if (!entry.isFile())
      throw new Error(`Module-impact shard must be a regular file: ${entry.name}`)
    return {
      path: `${shardDirectory}${entry.name}`,
      read: () => readFileSync(join(directory, entry.name), 'utf8')
    }
  })
  return assembleManifest(readFileSync(path, 'utf8'), shards)
}

// Read candidate blobs as data using trusted code, without checking out or executing them.
export function loadModuleImpactManifestAtRevision(revision, { cwd = process.cwd() } = {}) {
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const entries = git(
    'ls-tree',
    '-r',
    '-z',
    revision,
    '--',
    moduleImpactRegistrationPath,
    shardDirectory.slice(0, -1)
  )
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf('\t')
      const header = entry.slice(0, separator)
      const path = entry.slice(separator + 1)
      const [mode, type, oid] = header.split(' ')
      if (type !== 'blob' || !['100644', '100755'].includes(mode)) {
        throw new Error(`Module-impact registration must be a regular file: ${path}`)
      }
      return { path, read: () => git('cat-file', 'blob', oid) }
    })
  const root = entries.find(({ path }) => path === moduleImpactRegistrationPath)
  if (!root) throw new Error(`Missing module-impact manifest at ${revision}`)
  return assembleManifest(
    root.read(),
    entries.filter(({ path }) => path !== moduleImpactRegistrationPath)
  )
}
