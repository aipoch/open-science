import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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

// Marker line in an injected notice, used to keep injection idempotent.
const COMPUTE_NOTICE_MARKER = 'Compute environment unavailable in this app'

// Agent-facing preamble injected at the top of a compute-requiring skill's body. This app ships no GPU
// or model-execution backend, so a triggered biomodel skill would otherwise flail through package
// installs and CLI calls that end in cryptic "command not found" / missing-GPU errors. The notice tells
// the agent to stop up-front and report cleanly instead.
const COMPUTE_UNAVAILABLE_NOTICE = [
  '> [!IMPORTANT]',
  `> **${COMPUTE_NOTICE_MARKER}.** This skill drives GPU / model-inference tooling`,
  '> (model weights, CUDA, CLIs such as `colabfold_batch`) that is **not configured in this**',
  '> **environment** — there is no GPU and the Python/model toolchain is absent. Do NOT install',
  '> packages or run the model commands below; they will fail. Instead, tell the user plainly that',
  '> this skill needs a GPU or remote-compute environment that is not available here, and stop.',
  '',
  ''
].join('\n')

// Whether a skill's model tooling needs a compute backend this app does not provide — true for the
// biomodel category or any skill whose frontmatter requirements mention gpu/compute.
const requiresCompute = (skill: BundledSkill): boolean =>
  skill.category?.toLowerCase() === 'biomodels' ||
  /\b(gpu|compute)\b/i.test(skill.requirements ?? '')

// Prepends the compute-unavailable notice to a materialized skill's SKILL.md body, right after its
// frontmatter block so the YAML header stays first. Idempotent and best-effort: a missing file, an
// already-injected copy, or a write error leaves the copy as-is.
async function injectComputeNotice(target: string): Promise<void> {
  const file = join(target, 'SKILL.md')
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return
  }
  if (raw.includes(COMPUTE_NOTICE_MARKER)) return

  const frontmatter = /^---\n[\s\S]*?\n---\n?/.exec(raw)
  const updated = frontmatter
    ? `${raw.slice(0, frontmatter[0].length)}\n${COMPUTE_UNAVAILABLE_NOTICE}${raw.slice(frontmatter[0].length)}`
    : `${COMPUTE_UNAVAILABLE_NOTICE}${raw}`
  try {
    await writeFile(file, updated, 'utf8')
  } catch (error) {
    log.warn('failed to inject compute-unavailable notice', { target, error })
  }
}

// Recursively chmods a materialized skill tree. Read-only keeps the agent from writing generated files
// into a loaded skill dir; writable is applied before removal since a read-only dir cannot have its
// children unlinked. Best-effort: logs and continues on error, and no-ops when the dir is absent.
// POSIX-enforced only — on Windows a read-only directory does not enforce write-containment.
async function chmodTree(dir: string, mode: 'readonly' | 'writable'): Promise<void> {
  const dirMode = mode === 'readonly' ? 0o555 : 0o755
  const fileMode = mode === 'readonly' ? 0o444 : 0o644
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    log.warn('failed to read skill dir for chmod', { dir, error })
    return
  }
  for (const entry of entries) {
    const child = join(dir, entry.name)
    if (entry.isDirectory()) {
      await chmodTree(child, mode)
    } else {
      try {
        await chmod(child, fileMode)
      } catch (error) {
        log.warn('failed to chmod skill file', { child, error })
      }
    }
  }
  try {
    await chmod(dir, dirMode)
  } catch (error) {
    log.warn('failed to chmod skill dir', { dir, error })
  }
}

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
        const stale = join(skillsDir, name)
        try {
          // Restore write bits first: a read-only dir cannot have its children unlinked.
          await chmodTree(stale, 'writable')
          await rm(stale, { recursive: true, force: true })
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
        // Restore write bits before removal in case a prior sync left the dir read-only.
        await chmodTree(target, 'writable')
        await rm(target, { recursive: true, force: true })
        await cp(skill.sourceDir, target, { recursive: true, force: true })
        // Skills whose model tooling needs a compute backend this app lacks get an up-front notice so
        // the agent reports cleanly instead of failing through the model commands. Done before the
        // read-only chmod, which would otherwise block the rewrite.
        if (requiresCompute(skill)) await injectComputeNotice(target)
        // Loaded skills are read-only so the agent cannot write generated files into them.
        await chmodTree(target, 'readonly')
        versions[name] = version
      } catch (error) {
        log.warn('failed to materialize skill', { id: skill.id, error })
        delete versions[name]
      }
    }

    // Ensure every managed dir is read-only, including ones skipped as unchanged above — otherwise a
    // skill materialized as writable by an earlier version would stay writable until its version bumps.
    // chmod is idempotent and cheap, so re-applying it to unchanged dirs is safe.
    for (const name of wanted.keys()) {
      await chmodTree(join(skillsDir, name), 'readonly')
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
