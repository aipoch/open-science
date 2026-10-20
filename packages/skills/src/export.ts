import type { SkillHelperValidator } from './registered-helper-catalog'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import { zipSync, type Zippable } from 'fflate'
import { SKILL_IMPORT_LIMITS } from './skill-import-limits'
import type { BundledSkill } from './registry'
import { canonicalSkillDocument } from './skill-document-name'
import {
  inspectSkillPackage,
  SkillPackagePolicyError,
  type SkillPackageFile
} from './skill-package-inspection'
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

const normalizeExportedSkillDocument = (raw: string, name: string): string => {
  return canonicalSkillDocument(raw, name, { omitDisplayName: true })
}

export type SkillExportArchive = {
  fileName: string
  archiveBytes: Uint8Array
}

export const skillExportFileName = (displayName: string, fallbackId: string): string => {
  const sanitize = (value: string): string => {
    const fileStem = value
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
    return WINDOWS_RESERVED_BASENAME.test(fileStem) ? `skill-${fileStem}` : fileStem
  }
  return `${sanitize(displayName) || sanitize(fallbackId) || 'skill'}.zip`
}

const collectFiles = async (
  directory: string,
  skillName: string,
  storageRoot?: string,
  validateHelper?: SkillHelperValidator
): Promise<Zippable> => {
  let inventory: SkillPackageFile[]
  try {
    inventory = await inspectSkillPackage(directory, {
      storageRoot,
      validateHelper,
      rejectIgnoredPaths: true
    })
  } catch (error) {
    if (!(error instanceof SkillPackagePolicyError)) throw error
    if (error.reason === 'unsafePath') throw new Error('Skill path cannot be imported safely.')
    if (error.reason === 'symbolicLink' || error.reason === 'hardLink') {
      throw new Error('Unsafe Skill filesystem entry.')
    }
    if (error.reason === 'unsupportedEntry') {
      throw new Error('Unsupported Skill filesystem entry.')
    }
    if (error.reason === 'depthLimit') {
      throw new Error('Skill tree exceeds the export depth limit.')
    }
    if (error.reason === 'fileCountLimit') {
      throw new Error('Skill tree exceeds the export file-count limit.')
    }
    if (error.reason === 'fileSizeLimit') {
      throw new Error('Skill file exceeds the export size limit.')
    }
    throw new Error('Skill tree exceeds the total export size limit.')
  }

  const files: Zippable = {}
  let totalBytes = 0
  for (const file of inventory) {
    let bytes = new Uint8Array(await readFile(file.absolutePath))
    if (file.relativePath === 'SKILL.md') {
      bytes = new TextEncoder().encode(
        normalizeExportedSkillDocument(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
          skillName
        )
      )
    }
    totalBytes += bytes.byteLength
    if (bytes.byteLength > SKILL_IMPORT_LIMITS.maxFileBytes) {
      throw new Error('Skill file exceeds the export size limit.')
    }
    if (totalBytes > SKILL_IMPORT_LIMITS.maxTotalBytes) {
      throw new Error('Skill tree exceeds the total export size limit.')
    }
    files[file.relativePath] = [bytes, { mtime: new Date(1980, 0, 1) }]
  }
  return files
}

export const buildSkillExportArchive = async (
  skill: BundledSkill,
  storageRoot?: string,
  validateHelper?: SkillHelperValidator,
  compress: (files: Zippable) => Uint8Array | Promise<Uint8Array> = (files) =>
    zipSync(files, { level: 6 })
): Promise<SkillExportArchive> => ({
  fileName: skillExportFileName(skill.displayName, basename(skill.sourceDir) || skill.id),
  archiveBytes: await compress(
    await collectFiles(skill.sourceDir, skill.name, storageRoot, validateHelper)
  )
})
