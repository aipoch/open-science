import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SpecialistPackageSkillSnapshot } from '../specialist/package/skill-port'
import { SkillRegistry } from './registry'

const IGNORED_FILES = new Set(['.catalog_stamp', '.DS_Store', 'Thumbs.db'])

const snapshotDirectory = async (
  sourceDir: string
): Promise<{ files: Array<{ path: string; bytes: Uint8Array }>; contentHash: string }> => {
  const files: Array<{ path: string; bytes: Uint8Array }> = []
  const visit = async (directory: string, prefix = ''): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (IGNORED_FILES.has(entry.name) || entry.name === '__MACOSX') continue
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = join(directory, entry.name)
      const metadata = await lstat(absolute)
      if (metadata.isSymbolicLink() || (metadata.isFile() && metadata.nlink > 1)) {
        throw new Error('Unsafe builtin Skill filesystem entry.')
      }
      if (metadata.isDirectory()) {
        await visit(absolute, relative)
      } else if (metadata.isFile()) {
        files.push({ path: relative, bytes: new Uint8Array(await readFile(absolute)) })
      }
    }
  }
  await visit(sourceDir)
  files.sort((left, right) => left.path.localeCompare(right.path))
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.bytes)
    hash.update('\0')
  }
  return { files, contentHash: `sha256:${hash.digest('hex')}` }
}

export class BundledSkillSpecialistPackageAdapter {
  constructor(private readonly registry: SkillRegistry = new SkillRegistry()) {}

  async exportSnapshot(
    skillIds: readonly string[]
  ): Promise<ReadonlyArray<SpecialistPackageSkillSnapshot>> {
    const requested = new Set(skillIds)
    const result: SpecialistPackageSkillSnapshot[] = []
    for (const skill of await this.registry.list()) {
      if (skill.source !== 'featured' || !requested.has(skill.id)) continue
      const before = await snapshotDirectory(skill.sourceDir)
      const after = await snapshotDirectory(skill.sourceDir)
      if (before.contentHash !== after.contentHash) {
        throw new Error(`Builtin Skill ${skill.id} changed during export.`)
      }
      result.push({
        localId: skill.id,
        name: skill.name,
        version: skill.updatedAt || 'builtin',
        contentHash: after.contentHash,
        files: after.files
      })
    }
    return result.sort((left, right) => left.name.localeCompare(right.name))
  }
}
