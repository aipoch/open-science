import { chmod, lstat, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ClaudeCodeSkillMaterializer as Materializer } from '@aipoch/skills/projection'
import type { BundledSkill } from '@aipoch/skills'
import { createLogger } from '@aipoch/diagnostics/node'
import { COMPUTE_SKILL_ID } from '../compute/skill-doc'

const log = createLogger('skills')
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

async function chmodTree(dir: string, mode: 'readonly' | 'writable'): Promise<void> {
  const dirMode = mode === 'readonly' ? 0o555 : 0o755
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
        const executable = ((await lstat(child)).mode & 0o111) !== 0
        const fileMode =
          mode === 'readonly' ? (executable ? 0o555 : 0o444) : executable ? 0o755 : 0o644
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

export class ClaudeCodeSkillMaterializer extends Materializer {
  constructor() {
    super({
      beforeSync: async (skillsDir) => {
        const legacyComputeDir = join(skillsDir, COMPUTE_SKILL_ID)
        await chmodTree(legacyComputeDir, 'writable')
        await rm(legacyComputeDir, { recursive: true, force: true }).catch((error) =>
          log.warn('failed to remove legacy Compute Skill directory', { error })
        )
      },
      transformDocument: async (target, skill) => {
        if (requiresCompute(skill)) await injectComputeNotice(target)
      }
    })
  }
}
