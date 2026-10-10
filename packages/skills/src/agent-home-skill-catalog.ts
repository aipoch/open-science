import { realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  AgentHomeSkillRef,
  AgentHomeSkillSource,
  AgentHomeSkillView,
  AgentHomeSkillImportResult
} from './types'
import type { AgentHomeImportOptions } from './agent-home-skill-owner'
import type { ParsedSkillPreview } from './user-skill-import-contracts'
import type { UserSkillRepository } from './user-skill-repository'
import { SAFE_SKILL_DIRECTORY_NAME } from './user-skill-store'
import { SKILL_IMPORT_LIMITS } from './skill-import-limits'
import { createLogger, diagnosticErrorFields } from './diagnostics'

/** Caller-selected roots. The package does not discover application settings or home paths. */
export type AgentHomeSkillDirectory = { source: AgentHomeSkillSource; dir: string }
type DiscoveredAgentHomeSkill = {
  skill: AgentHomeSkillView
  realPath: string
  aliases: AgentHomeSkillRef[]
  fallbackAliases: AgentHomeSkillRef[]
  matchedFallbackDirectoryNames: Set<string>
  identityMigration?: {
    skill: AgentHomeSkillRef
    options: AgentHomeImportOptions
  }
}

const log = createLogger('skills')

/** Discovery, containment and legacy identity reconciliation share the repository's mutation owner. */
export class AgentHomeSkillCatalog {
  private readonly failedAgentHomeIdentityMigrationPaths = new Set<string>()
  constructor(private readonly userSkills: UserSkillRepository) {}

  async list(sources: readonly AgentHomeSkillDirectory[]): Promise<AgentHomeSkillView[]> {
    return (await this.discoverAgentHomeSkills(sources)).map((item) => item.skill)
  }

  async migrateIdentities(
    sources: readonly AgentHomeSkillDirectory[],
    reservedNames: readonly string[]
  ): Promise<void> {
    let discovered: DiscoveredAgentHomeSkill[]
    try {
      discovered = await this.discoverAgentHomeSkills(sources)
    } catch (error) {
      log.warn('Agent Home Skill identity migration scan failed', diagnosticErrorFields(error))
      return
    }

    for (const item of discovered) {
      if (!item.identityMigration) continue
      const pathKey = process.platform === 'win32' ? item.realPath.toLowerCase() : item.realPath
      try {
        await this.userSkills.importAgentHomeSkill(item.realPath, item.identityMigration.skill, {
          ...item.identityMigration.options,
          reservedNames
        })
        this.failedAgentHomeIdentityMigrationPaths.delete(pathKey)
      } catch (error) {
        this.failedAgentHomeIdentityMigrationPaths.add(pathKey)
        log.warn('Agent Home Skill identity migration failed', {
          source: item.identityMigration.skill.source,
          slug: item.identityMigration.skill.slug,
          ...diagnosticErrorFields(error)
        })
      }
    }
  }

  private async discoverAgentHomeSkills(
    sources: readonly AgentHomeSkillDirectory[]
  ): Promise<DiscoveredAgentHomeSkill[]> {
    const scanResults = await Promise.allSettled(
      sources.map(async ({ source, dir }) => {
        const skills = await this.userSkills.listAgentHomeSkills(dir, source)
        const visible: {
          skill: AgentHomeSkillView
          realPath: string
          alias: AgentHomeSkillRef
        }[] = []
        for (const skill of skills) {
          try {
            const realPath = await this.resolveAgentHomeSkillPath(source, skill.slug, sources)
            visible.push({
              realPath,
              alias: { source, slug: skill.slug },
              skill: {
                source,
                slug: skill.slug,
                name: skill.name,
                description: skill.description,
                alreadyImported: skill.alreadyImported
              }
            })
          } catch {
            continue
          }
        }
        return visible
      })
    )
    const groups = scanResults.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []
    )
    const firstFailure = scanResults.find((result) => result.status === 'rejected')
    if (groups.every((group) => group.length === 0) && firstFailure?.status === 'rejected') {
      throw firstFailure.reason
    }

    const unique = new Map<string, DiscoveredAgentHomeSkill>()
    for (const item of groups.flat()) {
      const pathKey = process.platform === 'win32' ? item.realPath.toLowerCase() : item.realPath
      const existing = unique.get(pathKey)
      if (existing) {
        existing.aliases.push(item.alias)
        existing.skill.alreadyImported ||= item.skill.alreadyImported
      } else {
        unique.set(pathKey, {
          skill: item.skill,
          realPath: item.realPath,
          aliases: [item.alias],
          fallbackAliases: [],
          matchedFallbackDirectoryNames: new Set()
        })
      }
    }

    const discovered = [...unique.values()]
    try {
      const matches = await this.userSkills.matchImportedAgentHomeSkills(
        discovered.map((item) => ({
          sourcePath: item.realPath,
          canonical: { source: item.skill.source, slug: item.skill.slug },
          aliases: item.aliases
        }))
      )
      for (const [index, match] of matches.entries()) {
        const item = discovered[index]
        if (!item) continue
        item.skill.alreadyImported = match.identityImported
        item.fallbackAliases.push(...match.fallbackAliases)
        if (
          match.identityMigrationNeeded &&
          match.matchedIdentitySignature &&
          match.matchedImportedIdentity
        ) {
          item.identityMigration = {
            skill: { source: item.skill.source, slug: item.skill.slug },
            options: {
              aliases: item.aliases,
              expectedSignature: match.matchedIdentitySignature,
              expectedImportedIdentity: match.matchedImportedIdentity
            }
          }
        }
      }
    } catch {
      // Keep readable rows when compatibility matching cannot inspect malformed legacy imports.
    }

    const fallbackBySlug = new Map<
      string,
      { item: DiscoveredAgentHomeSkill; alias: AgentHomeSkillRef }[]
    >()
    for (const item of discovered) {
      if (item.skill.alreadyImported) continue
      for (const alias of item.fallbackAliases) {
        const candidates = fallbackBySlug.get(alias.slug) ?? []
        candidates.push({ item, alias })
        fallbackBySlug.set(alias.slug, candidates)
      }
    }
    for (const [fallbackSlug, candidates] of fallbackBySlug) {
      for (const candidate of candidates) {
        candidate.item.skill.alreadyImported = true
        candidate.item.matchedFallbackDirectoryNames.add(fallbackSlug)
      }
    }
    for (const item of discovered) {
      if (!item.identityMigration) continue
      const pathKey = process.platform === 'win32' ? item.realPath.toLowerCase() : item.realPath
      if (this.failedAgentHomeIdentityMigrationPaths.has(pathKey)) {
        item.skill.alreadyImported = false
      }
    }
    return discovered
  }

  async previewAgentHomeSkill(
    availableSources: readonly AgentHomeSkillDirectory[],
    request: AgentHomeSkillRef
  ): Promise<ParsedSkillPreview & { sourceLabel: string }> {
    const requestedSourcePath = join(
      availableSources.find((candidate) => candidate.source === request.source)?.dir ?? '',
      request.slug
    )
    const sourcePath = await this.resolveAgentHomeSkillPath(
      request.source,
      request.slug,
      availableSources
    )
    const canonical = await this.canonicalAgentHomeSkillRef(sourcePath, availableSources)
    if (!canonical) {
      throw new Error('Refusing to preview installed skill outside a top-level skill directory.')
    }
    const sourceRoot =
      canonical.source === 'agents'
        ? '~/.agents/skills'
        : canonical.source === 'claude'
          ? '~/.claude/skills'
          : '~/.codex/skills'
    const sourceLabel = `${sourceRoot}/${canonical.slug}`
    const discovered = await this.discoverAgentHomeSkills(availableSources)
    const pathKey = process.platform === 'win32' ? sourcePath.toLowerCase() : sourcePath
    const aliases = discovered.find(
      (item) =>
        (process.platform === 'win32' ? item.realPath.toLowerCase() : item.realPath) === pathKey
    )?.aliases ?? [request]
    try {
      return {
        ...(await this.userSkills.previewAgentHomeSkill(sourcePath, canonical, aliases)),
        sourceLabel
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Could not preview the installed skill.'
      const redacted = [sourcePath, requestedSourcePath].reduce((value, hostPath) => {
        if (!hostPath) return value
        return value
          .split(`${hostPath}${sep}`)
          .join(`${sourceLabel}/`)
          .split(hostPath)
          .join(sourceLabel)
      }, message)
      throw new Error(redacted)
    }
  }

  async importAgentHomeSkills(
    availableSources: readonly AgentHomeSkillDirectory[],
    skills: readonly AgentHomeSkillRef[],
    reservedNames: readonly string[] = []
  ): Promise<AgentHomeSkillImportResult[]> {
    if (!Array.isArray(skills)) {
      throw new Error('Installed skills must be an array.')
    }
    if (skills.length > SKILL_IMPORT_LIMITS.maxSkillsPerBundle) {
      throw new Error(
        `Cannot import more than ${SKILL_IMPORT_LIMITS.maxSkillsPerBundle} installed skills at once.`
      )
    }

    const discovered = await this.discoverAgentHomeSkills(availableSources).catch(
      () => [] as DiscoveredAgentHomeSkill[]
    )
    const discoveredByPath = new Map(
      discovered.map((item) => [
        process.platform === 'win32' ? item.realPath.toLowerCase() : item.realPath,
        item
      ])
    )
    const results: AgentHomeSkillImportResult[] = []

    for (const skill of skills) {
      const candidate =
        typeof skill === 'object' && skill !== null
          ? (skill as { source?: unknown; slug?: unknown })
          : undefined
      const ref: Partial<AgentHomeSkillRef> = {}
      if (
        candidate?.source === 'agents' ||
        candidate?.source === 'claude' ||
        candidate?.source === 'codex'
      ) {
        ref.source = candidate.source
      }
      if (typeof candidate?.slug === 'string') ref.slug = candidate.slug

      try {
        if (!ref.source || ref.slug === undefined) {
          throw new Error('Installed skill entries must include a valid source and slug.')
        }
        const validated: AgentHomeSkillRef = { source: ref.source, slug: ref.slug }
        const sourcePath = await this.resolveAgentHomeSkillPath(
          validated.source,
          validated.slug,
          availableSources
        )
        const canonical = await this.canonicalAgentHomeSkillRef(sourcePath, availableSources)
        if (!canonical) {
          throw new Error('Refusing to import installed skill outside a top-level skill directory.')
        }
        const pathKey = process.platform === 'win32' ? sourcePath.toLowerCase() : sourcePath
        const discoveredSkill = discoveredByPath.get(pathKey)
        const outcome = await this.userSkills.importAgentHomeSkill(sourcePath, canonical, {
          aliases: discoveredSkill?.aliases,
          fallbackDirectoryNames: discoveredSkill
            ? [...discoveredSkill.matchedFallbackDirectoryNames]
            : undefined,
          reservedNames
        })
        results.push({ ...validated, ...outcome })
      } catch (error) {
        results.push({
          ...ref,
          error: error instanceof Error ? error.message : 'Could not import the installed skill.'
        })
      }
    }
    return results
  }

  private async resolveAgentHomeSkillPath(
    source: AgentHomeSkillSource,
    slug: string,
    availableSources: readonly AgentHomeSkillDirectory[]
  ): Promise<string> {
    const homeSkillsDir = availableSources.find((candidate) => candidate.source === source)?.dir
    if (!homeSkillsDir) {
      throw new Error(`Installed skill source "${String(source)}" is not available.`)
    }
    if (!SAFE_SKILL_DIRECTORY_NAME.test(slug)) {
      throw new Error(`Refusing to import installed skill with unsafe slug: ${slug}`)
    }
    const lexicalCandidate = resolve(homeSkillsDir, slug)
    const candidate = await realpath(lexicalCandidate).catch(() => lexicalCandidate)
    const allowedRoots = await Promise.all(
      availableSources.map(({ dir }) => realpath(dir).catch(() => resolve(dir)))
    )
    const withinAllowedRoot = allowedRoots.some((root) => {
      const rootWithSep = root.endsWith(sep) ? root : root + sep
      return candidate === root || candidate.startsWith(rootWithSep)
    })
    if (!withinAllowedRoot) {
      throw new Error(`Refusing to import installed skill outside its source: ${slug}`)
    }
    if (!(await this.canonicalAgentHomeSkillRef(candidate, availableSources))) {
      throw new Error(
        `Refusing to import installed skill outside a top-level skill directory: ${slug}`
      )
    }
    return candidate
  }

  private async canonicalAgentHomeSkillRef(
    realSkillPath: string,
    availableSources: readonly AgentHomeSkillDirectory[]
  ): Promise<AgentHomeSkillRef | undefined> {
    for (const source of availableSources) {
      const realRoot = await realpath(source.dir).catch(() => resolve(source.dir))
      const child = relative(realRoot, realSkillPath)
      if (
        child &&
        !isAbsolute(child) &&
        child !== '..' &&
        !child.startsWith(`..${sep}`) &&
        !child.includes(sep) &&
        SAFE_SKILL_DIRECTORY_NAME.test(child)
      ) {
        return { source: source.source, slug: child }
      }
    }
    return undefined
  }
}
