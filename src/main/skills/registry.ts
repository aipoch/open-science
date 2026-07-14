import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SkillSource } from '../../shared/settings'
import { createLogger } from '../logger'
import { parseFrontmatter } from './frontmatter'
import { resolveBundledSkillsRoot } from './resource-path'

const log = createLogger('skills')

// One bundled skill resolved from manifest + its SKILL.md. `sourceDir` is the absolute directory the
// materializer copies from; author/license/thirdParty/category/requirements come from the SKILL.md
// frontmatter (may be absent). `category`/`requirements` let the materializer flag skills whose model
// tooling needs a compute backend this app does not provide.
export type BundledSkill = {
  id: string
  name: string
  description: string
  source: SkillSource
  updatedAt: string
  sourceDir: string
  author?: string
  license?: string
  thirdParty?: string
  category?: string
  requirements?: string
}

type ManifestEntry = { id: string; name: string; source: SkillSource; updatedAt: string }

const SAFE_ID = /^[a-z0-9-]+$/

// Reads and validates the manifest, dropping malformed entries.
const readManifest = async (rootDir: string): Promise<ManifestEntry[]> => {
  try {
    const raw = await readFile(join(rootDir, 'manifest.json'), 'utf8')
    const parsed = JSON.parse(raw) as unknown

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as { skills?: unknown }).skills)
    ) {
      return []
    }

    return (parsed as { skills: unknown[] }).skills.filter((entry): entry is ManifestEntry => {
      const record = entry as Record<string, unknown>
      return (
        typeof record?.id === 'string' &&
        SAFE_ID.test(record.id) &&
        typeof record?.name === 'string' &&
        record?.source === 'featured' &&
        typeof record?.updatedAt === 'string'
      )
    })
  } catch {
    return []
  }
}

// Reads bundled skills shipped with the app. Malformed/missing entries are skipped, never thrown, so a
// single bad skill can never break the panel or block an agent spawn. The bundled-skills root is
// resolved lazily on first read so constructing a registry never touches electron (safe under tests).
class SkillRegistry {
  private readonly explicitRootDir?: string

  constructor(rootDir?: string) {
    this.explicitRootDir = rootDir
  }

  private get rootDir(): string {
    return this.explicitRootDir ?? resolveBundledSkillsRoot()
  }

  async list(): Promise<BundledSkill[]> {
    const entries = await readManifest(this.rootDir)
    const skills: BundledSkill[] = []

    for (const entry of entries) {
      const sourceDir = join(this.rootDir, entry.id)

      try {
        const raw = await readFile(join(sourceDir, 'SKILL.md'), 'utf8')
        const { fields } = parseFrontmatter(raw)

        skills.push({
          id: entry.id,
          name: entry.name,
          description: fields.description ?? '',
          source: entry.source,
          updatedAt: entry.updatedAt,
          sourceDir,
          author: fields.author,
          license: fields.license,
          // The "Third-party software, content, terms, and information" row; several key spellings.
          thirdParty: fields['third-party'] ?? fields['third_party'] ?? fields.thirdparty,
          category: fields.category,
          requirements: fields.requirements
        })
      } catch (error) {
        log.warn('skipping bundled skill with unreadable SKILL.md', { id: entry.id, error })
      }
    }

    // Featured skills always display alphabetically by name; the manifest order is not significant.
    return skills.sort((a, b) => a.name.localeCompare(b.name))
  }

  async body(id: string): Promise<string> {
    const raw = await readFile(join(this.rootDir, id, 'SKILL.md'), 'utf8')

    return parseFrontmatter(raw).body
  }
}

export { SkillRegistry }
