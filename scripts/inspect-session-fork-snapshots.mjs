/* eslint-disable @typescript-eslint/explicit-function-return-type -- Standalone JavaScript CLI. */
// Run against an idle data root. Counts regular-file lengths, not reclaimable filesystem blocks.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { readFileWithinLimit } from '@aipoch/durable-files'

const usage = 'Usage: node scripts/inspect-session-fork-snapshots.mjs <Open Science data root>'
const [root, ...extra] = process.argv.slice(2)
if (!root || root === '--help' || extra.length) {
  console.log(usage)
  process.exit(root === '--help' && !extra.length ? 0 : 1)
}

const limit = 256 * 1024 ** 2
const metadataFiles = ['manifest.json', 'records.json']
const optionalStat = async (path) =>
  lstat(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error
  })
async function requireDirectory(path) {
  if (!(await lstat(path)).isDirectory()) throw new Error('Expected a regular directory')
}
async function readText(path, maxBytes) {
  if (!(await lstat(path)).isFile()) throw new Error('Expected a regular file')
  return readFileWithinLimit(path, maxBytes)
}

async function inspect(directory, projectId, sessionId) {
  await requireDirectory(directory)
  const receipt = JSON.parse(await readText(join(directory, 'receipt.json'), limit))
  const owner = await readText(join(directory, '..', '.session-package-owner'), 256)
  if (
    receipt.schemaVersion !== 1 ||
    receipt.projectId !== projectId ||
    receipt.sessionId !== sessionId ||
    !owner ||
    owner !== receipt.importId ||
    (receipt.nativeLogOrigin !== undefined && receipt.nativeLogOrigin !== true)
  )
    throw new Error('Fork receipt does not match its owner')
  const source = join(directory, 'source')
  const metadata = receipt.nativeLogOrigin ? join(directory, 'origin-metadata') : source
  await requireDirectory(metadata)
  const text = await readText(join(metadata, 'manifest.json'), limit)
  if (createHash('sha256').update(text).digest('hex') !== receipt.manifestChecksum)
    throw new Error('Origin manifest checksum mismatch')
  const manifest = JSON.parse(text)
  if (
    manifest.format !== 'open-science-session' ||
    manifest.schemaVersion !== 1 ||
    manifest.source?.projectId !== receipt.sourceProjectId ||
    manifest.source?.sessionId !== receipt.sourceSessionId
  )
    throw new Error('Origin manifest does not match the receipt')
  const members = new Map(manifest.inventory.map((entry) => [entry.path, entry]))
  const records = join(metadata, 'records.json')
  const info = await lstat(records)
  if (!info.isFile() || info.size > limit || info.size !== members.get('records.json')?.sizeBytes)
    throw new Error('Invalid origin records file')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(records)) hash.update(chunk)
  if (hash.digest('hex') !== members.get('records.json').checksum)
    throw new Error('Origin records checksum mismatch')

  let sourceBytes = 0
  let metadataBytesInSource = 0
  async function count(relativeDirectory) {
    for (const entry of await readdir(join(source, relativeDirectory), { withFileTypes: true })) {
      if (!relativeDirectory && entry.name === 'objects' && entry.isDirectory()) {
        await count('objects')
        continue
      }
      const key = relativeDirectory ? relativeDirectory + '/' + entry.name : entry.name
      if (!entry.isFile() || (key !== 'manifest.json' && !members.has(key)))
        throw new Error('Unexpected entry in retained source')
      const stat = await lstat(join(source, key))
      const expected =
        key === 'manifest.json' ? Buffer.byteLength(text) : members.get(key).sizeBytes
      if (!stat.isFile() || stat.size !== expected)
        throw new Error('Retained source member size mismatch')
      sourceBytes += stat.size
      if (metadata === source && metadataFiles.includes(key)) metadataBytesInSource += stat.size
    }
  }
  const retained = await optionalStat(source)
  if (retained) {
    if (!retained.isDirectory()) throw new Error('Invalid retained source directory')
    await count('')
  }
  return { sourceBytes, metadataBytesInSource, candidateBytes: sourceBytes - metadataBytesInSource }
}

const artifacts = join(resolve(root), 'artifacts')
await requireDirectory(artifacts)
const forks = []
const issues = []
for (const project of await readdir(artifacts, { withFileTypes: true })) {
  if (project.isSymbolicLink())
    issues.push({ projectId: project.name, issue: 'Skipped project symlink' })
  if (!project.isDirectory()) continue
  const projectPath = join(artifacts, project.name)
  for (const session of await readdir(projectPath, { withFileTypes: true })) {
    const id = { projectId: project.name, sessionId: session.name }
    if (session.isSymbolicLink()) issues.push({ ...id, issue: 'Skipped session symlink' })
    if (!session.isDirectory()) continue
    try {
      const directory = join(projectPath, session.name, '.session-fork')
      if (await optionalStat(directory))
        forks.push({ ...id, ...(await inspect(directory, project.name, session.name)) })
    } catch (error) {
      issues.push({ ...id, issue: error.message })
    }
  }
}
const candidateBytes = forks.reduce((sum, fork) => sum + fork.candidateBytes, 0)
console.log(JSON.stringify({ forks, candidateBytes, issues }, null, 2))
if (issues.length) process.exitCode = 1
