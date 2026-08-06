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

type CodexSkillFile = {
  name: string
  path: string
}

type CodexSkillProjection = {
  event: AcpRuntimeEvent
  skillFile?: CodexSkillFile
}

const exactSkillFile = (skillsRoot: string, event: AcpRuntimeEvent): CodexSkillFile | undefined => {
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

  const resolvedPath = resolve(location)
  const relativePath = relative(skillsRoot, resolvedPath)
  const parts = relativePath.split(sep)
  if (parts.length !== 2 || parts[1] !== 'SKILL.md' || !parts[0] || !isSafeSkillName(parts[0])) {
    return undefined
  }

  return { name: parts[0], path: resolvedPath }
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
  private readonly activeSkills = new Map<
    string,
    Readonly<{ sessionId: string; skillFile: CodexSkillFile }>
  >()

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

  clearSession(sessionId: string): void {
    for (const [key, activity] of this.activeSkills) {
      if (activity.sessionId === sessionId) this.activeSkills.delete(key)
    }
  }

  project(event: AcpRuntimeEvent): AcpRuntimeEvent {
    return this.projectWithContext(event).event
  }

  projectWithContext(event: AcpRuntimeEvent): CodexSkillProjection {
    if (event.kind !== 'tool' || !event.toolCallId || !this.skillsRoot) return { event }

    const key = lifecycleKey(event)
    const detectedSkill = exactSkillFile(this.skillsRoot, event)
    if (detectedSkill) {
      this.activeSkills.set(key, {
        sessionId: event.sessionId ?? '',
        skillFile: detectedSkill
      })
    }

    const skillFile = detectedSkill ?? this.activeSkills.get(key)?.skillFile
    if (!skillFile) return { event }

    if (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled') {
      this.activeSkills.delete(key)
    }

    return { event: projectNameOnly(event, skillFile.name), skillFile }
  }
}

export { CodexSkillActivityProjector }
export type { CodexSkillFile, CodexSkillProjection }
