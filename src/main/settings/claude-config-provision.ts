import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

// The app owns its Claude config directory (`<storageRoot>/claude`), shared by every provider and kept
// separate from the user's `~/.claude`. This module ensures that directory exists before the agent
// spawns, and is the single place where the app injects its OWN skills / plugins / commands.
//
// This change lands the MECHANISM only — the asset content is added later. The subdirs are created so
// that injected content has a stable, claude-readable home; they intentionally do NOT read from or copy
// anything out of `~/.claude`.

// Subdirs claude loads app-scoped assets from. App-owned; never synced with ~/.claude.
const APP_ASSET_SUBDIRS = ['skills', 'plugins', 'commands'] as const

// Ensures the app config dir and its asset subdirs exist. Idempotent and safe to call before each
// agent spawn. The app's OWN skills/plugins/commands are injected into these subdirs in a later change
// (this lands the mechanism only); nothing is read from or copied out of ~/.claude.
const provisionAppClaudeConfigDir = async (configDir: string): Promise<void> => {
  await mkdir(configDir, { recursive: true })
  await Promise.all(
    APP_ASSET_SUBDIRS.map((sub) => mkdir(join(configDir, sub), { recursive: true }))
  )
  // Extension point: inject the app's bundled skills/plugins/commands into the subdirs here.
}

export { APP_ASSET_SUBDIRS, provisionAppClaudeConfigDir }
