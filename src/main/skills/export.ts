import { lstat, readFile, readdir } from 'node:fs/promises'
import { basename, join, posix } from 'node:path'

import { zipSync, type Zippable } from 'fflate'

import { SKILL_IMPORT_LIMITS } from '../../shared/skill-import-limits'
import type { BundledSkill } from './registry'
import { isUnsafeSkillArchivePath } from './zip-extract'

const INTERNAL_SKILL_FILES = new Set(['.source.json', '.specialist-package.json'])
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

export type SkillExportArchive = {
  fileName: string
  archiveBytes: Uint8Array
}

export const skillExportFileName = (displayName: string, fallbackId: string): string => {
  const sanitize = (value: string): string => {
    const slug = value
      .normalize('NFKC')
      .trim()
      .toLocaleLowerCase('en-US')
      .replace(/[<>:"/\\|?*]/g, '-')
      .split('')
      .map((character) => (character.charCodeAt(0) < 32 ? '-' : character))
      .join('')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
      .replace(/-+$/g, '')
    return WINDOWS_RESERVED_BASENAME.test(slug) ? `skill-${slug}` : slug
  }
  return `${sanitize(displayName) || sanitize(fallbackId) || 'skill'}.zip`
}

type SkillExportDialog = {
  showSaveDialog: (options: {
    title: string
    defaultPath: string
    filters: Array<{ name: string; extensions: string[] }>
  }) => Promise<{ canceled: boolean; filePath?: string }>
  writeFile: (filePath: string, bytes: Uint8Array) => Promise<unknown>
}

const collectFiles = async (
  directory: string,
  relativeDirectory = '',
  state: { files: Zippable; fileCount: number; totalBytes: number } = {
    files: {},
    fileCount: 0,
    totalBytes: 0
  },
  depth = 0
): Promise<Zippable> => {
  if (depth > SKILL_IMPORT_LIMITS.maxDepth) {
    throw new Error('Skill tree exceeds the export depth limit.')
  }
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of entries) {
    if (!relativeDirectory && INTERNAL_SKILL_FILES.has(entry.name)) continue
    const relativePath = relativeDirectory ? posix.join(relativeDirectory, entry.name) : entry.name
    if (isUnsafeSkillArchivePath(relativePath)) {
      throw new Error('Skill path cannot be imported safely.')
    }
    const absolutePath = join(directory, entry.name)
    const metadata = await lstat(absolutePath)
    if (metadata.isSymbolicLink() || (metadata.isFile() && metadata.nlink > 1)) {
      throw new Error('Unsafe Skill filesystem entry.')
    }
    if (metadata.isDirectory()) {
      await collectFiles(absolutePath, relativePath, state, depth + 1)
    } else if (metadata.isFile()) {
      state.fileCount += 1
      state.totalBytes += metadata.size
      if (state.fileCount > SKILL_IMPORT_LIMITS.maxFiles) {
        throw new Error('Skill tree exceeds the export file-count limit.')
      }
      if (metadata.size > SKILL_IMPORT_LIMITS.maxFileBytes) {
        throw new Error('Skill file exceeds the export size limit.')
      }
      if (state.totalBytes > SKILL_IMPORT_LIMITS.maxTotalBytes) {
        throw new Error('Skill tree exceeds the total export size limit.')
      }
      const bytes = new Uint8Array(await readFile(absolutePath))
      state.totalBytes += bytes.byteLength - metadata.size
      if (bytes.byteLength > SKILL_IMPORT_LIMITS.maxFileBytes) {
        throw new Error('Skill file exceeds the export size limit.')
      }
      if (state.totalBytes > SKILL_IMPORT_LIMITS.maxTotalBytes) {
        throw new Error('Skill tree exceeds the total export size limit.')
      }
      state.files[relativePath] = [bytes, { mtime: new Date('1980-01-01T00:00:00.000Z') }]
    } else {
      throw new Error('Unsupported Skill filesystem entry.')
    }
  }

  return state.files
}

export const buildSkillExportArchive = async (
  skill: BundledSkill
): Promise<SkillExportArchive> => ({
  fileName: skillExportFileName(skill.name, basename(skill.sourceDir) || skill.id),
  archiveBytes: zipSync(await collectFiles(skill.sourceDir), { level: 6 })
})

export const saveSkillExport = async (
  adapter: SkillExportDialog,
  archive: SkillExportArchive
): Promise<{ saved: boolean }> => {
  const selected = await adapter.showSaveDialog({
    title: 'Export Skill',
    defaultPath: archive.fileName,
    filters: [{ name: 'Skill ZIP', extensions: ['zip'] }]
  })
  if (selected.canceled || !selected.filePath) return { saved: false }
  await adapter.writeFile(selected.filePath, archive.archiveBytes)
  return { saved: true }
}
