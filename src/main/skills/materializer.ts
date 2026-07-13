import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createLogger } from '../logger'
import type { BundledSkill } from './registry'

const log = createLogger('skills')

// Bundled skills are materialized under this prefix so the sync only ever manages its own directories
// and never touches imported/personal/user skills that may live alongside them later.
const OS_SKILL_PREFIX = 'os-'

// Tracks the version (updatedAt) last materialized per managed dir so unchanged skills are skipped
// instead of recopied on every spawn. Not a skill dir, so the claude skill loader ignores it.
const VERSION_MANIFEST = '.os-versions.json'

// Writes an enabled skill set into a framework's config dir. One implementation per agent framework.
interface SkillMaterializer {
  sync(configDir: string, enabled: BundledSkill[]): Promise<void>
}

// Materializes bundled skills into `<configDir>/skills/os-<id>/` for Claude Code. The target state is
// exactly the enabled set: enabled skills are copied when new or when their version changed, and os-
// dirs not in the set are removed. Directories without the os- prefix are never touched.
class ClaudeCodeSkillMaterializer implements SkillMaterializer {
  async sync(configDir: string, enabled: BundledSkill[]): Promise<void> {
    const skillsDir = join(configDir, 'skills')
    await mkdir(skillsDir, { recursive: true })

    const wanted = new Map(enabled.map((skill) => [`${OS_SKILL_PREFIX}${skill.id}`, skill]))

    let existing: string[] = []
    try {
      existing = await readdir(skillsDir)
    } catch {
      existing = []
    }
    const existingDirs = new Set(existing)
    const versions = await this.readVersions(skillsDir)

    // Remove managed dirs that should no longer exist (disabled or removed skills).
    for (const name of existing) {
      if (name.startsWith(OS_SKILL_PREFIX) && !wanted.has(name)) {
        try {
          await rm(join(skillsDir, name), { recursive: true, force: true })
        } catch (error) {
          log.warn('failed to remove stale skill dir', { name, error })
        }
        delete versions[name]
      }
    }

    // Copy new or changed skills. A skill with a stable, unchanged version whose dir already exists is
    // skipped; one with no version (empty updatedAt) is always recopied.
    for (const [name, skill] of wanted) {
      const version = skill.updatedAt || ''
      const unchanged = version !== '' && existingDirs.has(name) && versions[name] === version
      if (unchanged) continue

      const target = join(skillsDir, name)
      try {
        await rm(target, { recursive: true, force: true })
        await cp(skill.sourceDir, target, { recursive: true, force: true })
        versions[name] = version
      } catch (error) {
        log.warn('failed to materialize skill', { id: skill.id, error })
        delete versions[name]
      }
    }

    await this.writeVersions(skillsDir, versions)
  }

  // Reads the version manifest, returning an empty map when absent or corrupt.
  private async readVersions(skillsDir: string): Promise<Record<string, string>> {
    try {
      const raw = await readFile(join(skillsDir, VERSION_MANIFEST), 'utf8')
      const parsed = JSON.parse(raw) as unknown

      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}

      const versions: Record<string, string> = {}
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') versions[key] = value
      }
      return versions
    } catch {
      return {}
    }
  }

  private async writeVersions(skillsDir: string, versions: Record<string, string>): Promise<void> {
    try {
      await writeFile(join(skillsDir, VERSION_MANIFEST), JSON.stringify(versions), 'utf8')
    } catch (error) {
      log.warn('failed to write skill version manifest', { error })
    }
  }
}

export { ClaudeCodeSkillMaterializer, OS_SKILL_PREFIX }
export type { SkillMaterializer }
