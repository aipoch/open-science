import { isAbsolute, relative, resolve, sep } from 'node:path'

import type { AcpRuntimeEvent } from '../../shared/acp'

const isSafeSkillName = (value: string): boolean =>
  value.length > 0 &&
  !value.includes('/') &&
  !value.includes('\\') &&
  ![...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
  })

const exactSkillName = (skillsRoot: string, event: AcpRuntimeEvent): string | undefined => {
  if (
    event.kind !== 'tool' ||
    event.toolKind !== 'read' ||
    !event.toolCallId ||
    event.toolLocations?.length !== 1
  ) {
    return undefined
  }

  const location = event.toolLocations[0]?.path
  if (!location || !isAbsolute(location)) return undefined

  const relativePath = relative(skillsRoot, resolve(location))
  const parts = relativePath.split(sep)
  if (parts.length !== 2 || parts[1] !== 'SKILL.md' || !parts[0] || !isSafeSkillName(parts[0])) {
    return undefined
  }

  return parts[0]
}

const projectNameOnly = (event: AcpRuntimeEvent, skillName: string): AcpRuntimeEvent => {
  const safe = { ...event }
  delete safe.raw
  delete safe.toolContent
  delete safe.toolLocations
  delete safe.rawInput
  delete safe.rawOutput
  delete safe.terminalOutput
  delete safe.terminalExitCode

  return {
    ...safe,
    title:
      event.status === 'completed' ? `Loaded skill: ${skillName}` : `Loading skill: ${skillName}`
  }
}

const lifecycleKey = (event: AcpRuntimeEvent): string =>
  JSON.stringify([event.sessionId ?? '', event.toolCallId])

// Presentation-only state for Codex's native Skill reads. It never authorizes a tool or gates a
// Connector; it only replaces the exact app-owned SKILL.md read lifecycle with a name-only activity.
class CodexSkillActivityProjector {
  private skillsRoot: string | undefined
  private readonly activeSkills = new Map<string, string>()

  constructor(skillsRoot?: string) {
    this.skillsRoot = skillsRoot ? resolve(skillsRoot) : undefined
  }

  setSkillsRoot(skillsRoot: string | undefined): void {
    const nextRoot = skillsRoot ? resolve(skillsRoot) : undefined
    if (nextRoot === this.skillsRoot) return

    this.skillsRoot = nextRoot
    this.activeSkills.clear()
  }

  clear(): void {
    this.activeSkills.clear()
  }

  project(event: AcpRuntimeEvent): AcpRuntimeEvent {
    if (event.kind !== 'tool' || !event.toolCallId || !this.skillsRoot) return event

    const key = lifecycleKey(event)
    const detectedName = exactSkillName(this.skillsRoot, event)
    if (detectedName) this.activeSkills.set(key, detectedName)

    const skillName = detectedName ?? this.activeSkills.get(key)
    if (!skillName) return event

    if (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled') {
      this.activeSkills.delete(key)
    }

    return projectNameOnly(event, skillName)
  }
}

export { CodexSkillActivityProjector }
