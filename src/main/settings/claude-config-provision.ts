import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { ClaudeCodeSkillMaterializer, type SkillMaterializer } from '../skills/materializer'
import { SkillRegistry, type BundledSkill } from '../skills/registry'

// The app owns its Claude config directory (`<storageRoot>/claude`), shared by every provider and kept
// separate from the user's `~/.claude`. This module ensures that directory exists and injects the app's
// OWN skills before the agent spawns. It never reads from or copies anything out of ~/.claude.

// Subdirs claude loads app-scoped assets from. App-owned; never synced with ~/.claude.
const APP_ASSET_SUBDIRS = ['skills', 'plugins', 'commands'] as const

type ProvisionOptions = {
  // The full skill catalog (featured + imported + personal). Defaults to bundled skills only.
  skills?: BundledSkill[]
  materializer?: SkillMaterializer
  disabledSkillIds?: string[]
}

// Ensures the app config dir + asset subdirs exist, then materializes the enabled skill set into
// `<configDir>/skills`. Idempotent and safe to call before each agent spawn. Skill materialization
// failures are swallowed by the materializer so a bad skill never blocks the spawn.
const provisionAppClaudeConfigDir = async (
  configDir: string,
  options: ProvisionOptions = {}
): Promise<void> => {
  await mkdir(configDir, { recursive: true })
  await Promise.all(
    APP_ASSET_SUBDIRS.map((sub) => mkdir(join(configDir, sub), { recursive: true }))
  )

  const materializer = options.materializer ?? new ClaudeCodeSkillMaterializer()
  const skills = options.skills ?? (await new SkillRegistry().list())
  const disabled = new Set(options.disabledSkillIds ?? [])
  const enabled = skills.filter((skill) => !disabled.has(skill.id))

  await materializer.sync(configDir, enabled)
}

export { APP_ASSET_SUBDIRS, provisionAppClaudeConfigDir }
