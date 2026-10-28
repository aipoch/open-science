import { lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'

// Only rebuildable Skill projections belong here, never provider homes or credentials.
// Keep this filesystem contract in sync with the framework projection layouts.
const skillProjectionPaths = [
  ['codex', 'skills'],
  ['codex-subscription', 'skills'],
  ['opencode', 'config', 'opencode', 'skills'],
  ['runtime-support', 'agent-skills', 'claude'],
  ['codebuddy', 'skill-runtime', '.claude', 'skills']
] as const

export async function managedSkillReadRoots(configRoot: string): Promise<string[]> {
  const root = await realpath(configRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!root) return []
  const roots = await Promise.all(
    skillProjectionPaths.map(async (segments) => {
      let current = root
      for (const segment of segments) {
        current = join(current, segment)
        const metadata = await lstat(current).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined
          throw error
        })
        // Do not turn a replaced projection or intermediate directory into authority
        // over its symlink/junction target. Missing frameworks need no grant or mkdir.
        if (!metadata?.isDirectory() || metadata.isSymbolicLink()) return undefined
      }
      return current
    })
  )
  return roots.filter((root): root is string => root !== undefined)
}
