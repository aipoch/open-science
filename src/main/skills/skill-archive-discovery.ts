import type { FetchedSkillFile } from './github-import'
import type { SkippedSkill } from '../../shared/settings'
import { SKILL_IMPORT_LIMITS } from '../../shared/skill-import-limits'
import { selectSkillManifestRoots } from './skill-bundle-paths'
import { extractZip, extractZipLenient } from './zip-extract'
export type SkillRoot = { subPath: string; files: FetchedSkillFile[] }
export type SkillDiscovery = { roots: SkillRoot[]; skipped: SkippedSkill[] }
const findSkillRoots = (entries: { path: string; content: Buffer }[]): SkillRoot[] => {
  const roots = selectSkillManifestRoots(entries.map((entry) => entry.path))
  return roots.map((subPath) => {
    const prefix = subPath === '' ? '' : `${subPath}/`
    const files = entries
      .filter((entry) => entry.path.startsWith(prefix))
      .map((entry) => ({ relativePath: entry.path.slice(prefix.length), content: entry.content }))
    return { subPath, files }
  })
}

const isNestedArchive = (path: string): boolean => /\.(zip|skill)$/i.test(path)

const reasonFromError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^(Error invoking remote method '[^']*': )?(Error: )?/, '') || 'unreadable'
}

const mb = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`

const perSkillCapReason = (files: FetchedSkillFile[]): string | null => {
  if (files.length > SKILL_IMPORT_LIMITS.maxFiles) {
    return `skill has more than ${SKILL_IMPORT_LIMITS.maxFiles} files`
  }
  if (files.some((file) => file.content.length > SKILL_IMPORT_LIMITS.maxFileBytes)) {
    return `contains a file over ${mb(SKILL_IMPORT_LIMITS.maxFileBytes)}`
  }
  const total = files.reduce((sum, file) => sum + file.content.length, 0)
  if (total > SKILL_IMPORT_LIMITS.maxTotalBytes) {
    return `skill exceeds ${mb(SKILL_IMPORT_LIMITS.maxTotalBytes)}`
  }
  return null
}

export const discoverSkillRoots = (zip: Buffer): SkillDiscovery => {
  const skipped: SkippedSkill[] = []
  const { files, skipped: outerSkips } = extractZipLenient(zip, {
    maxFiles: SKILL_IMPORT_LIMITS.maxBundleEntries,
    maxFileBytes: SKILL_IMPORT_LIMITS.maxSkillArchiveBytes,
    maxTotalBytes: SKILL_IMPORT_LIMITS.maxBundleBytes,
    maxDepth: SKILL_IMPORT_LIMITS.maxDepth
  })
  for (const entry of outerSkips) skipped.push({ source: entry.path, reason: entry.reason })

  const roots: SkillRoot[] = []
  const used = new Set<string>()
  const addRoot = (subPath: string, rootFiles: FetchedSkillFile[]): void => {
    let unique = subPath
    for (let n = 2; used.has(unique); n += 1) unique = `${subPath}#${n}`
    used.add(unique)
    roots.push({ subPath: unique, files: rootFiles })
  }

  const looseRoots = findSkillRoots(files.filter((file) => !isNestedArchive(file.path)))
  const rootPrefixes = looseRoots.map((root) => ({
    root,
    prefix: root.subPath === '' ? '' : `${root.subPath}/`
  }))

  const standaloneArchives: typeof files = []
  for (const archive of files.filter((file) => isNestedArchive(file.path))) {
    const owner = rootPrefixes.find(({ prefix }) => archive.path.startsWith(prefix))
    if (owner) {
      owner.root.files.push({
        relativePath: archive.path.slice(owner.prefix.length),
        content: archive.content
      })
    } else {
      standaloneArchives.push(archive)
    }
  }

  for (const { root, prefix } of rootPrefixes) {
    const droppedFile = outerSkips.find(
      (entry) => entry.path === root.subPath || entry.path.startsWith(prefix)
    )
    if (droppedFile) {
      skipped.push({
        source: root.subPath || 'skill',
        reason: `contains a file that couldn't be imported (${droppedFile.reason})`
      })
      continue
    }
    const violation = perSkillCapReason(root.files)
    if (violation) {
      skipped.push({ source: root.subPath || 'skill', reason: violation })
      continue
    }
    addRoot(root.subPath, root.files)
  }

  for (const archive of standaloneArchives) {
    let innerRoots: SkillRoot[]
    try {
      innerRoots = findSkillRoots(extractZip(archive.content))
    } catch (error) {
      skipped.push({ source: archive.path, reason: reasonFromError(error) })
      continue
    }
    if (innerRoots.length === 0) {
      skipped.push({ source: archive.path, reason: 'no SKILL.md found' })
      continue
    }
    for (const root of innerRoots) {
      addRoot(root.subPath === '' ? archive.path : `${archive.path}/${root.subPath}`, root.files)
    }
  }

  if (roots.length > SKILL_IMPORT_LIMITS.maxSkillsPerBundle) {
    for (const dropped of roots.splice(SKILL_IMPORT_LIMITS.maxSkillsPerBundle)) {
      skipped.push({
        source: dropped.subPath || 'skill',
        reason: `bundle has more than ${SKILL_IMPORT_LIMITS.maxSkillsPerBundle} skills`
      })
    }
  }

  return { roots: roots.sort((left, right) => left.subPath.localeCompare(right.subPath)), skipped }
}
