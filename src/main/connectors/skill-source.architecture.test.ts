import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { connectorSkillSourceRoot } from './skill-source'

const projectRoot = resolve(__dirname, '../../..')
const sourceRoot = resolve(projectRoot, 'src')
const portablePath = (path: string): string => relative(projectRoot, path).replaceAll('\\', '/')
const readSource = (path: string): string => readFileSync(path, 'utf8')
const productionSources = (): string[] => {
  const sources: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (
        ['.ts', '.tsx'].includes(extname(path)) &&
        !/\.(?:test|spec)\.[cm]?tsx?$/.test(entry.name)
      ) {
        sources.push(path)
      }
    }
  }
  visit(sourceRoot)
  return sources.sort()
}

describe('Connector Skill derived-source ownership', () => {
  it('keeps the versioned source outside every framework rollback catalog', () => {
    const configRoot = join('/config', 'open-science')
    const source = connectorSkillSourceRoot(configRoot)

    expect(source).toBe(join(configRoot, 'runtime-support', 'connector-skills-v1'))
    expect(source).not.toContain(`${join(configRoot, 'claude', 'skills')}`)
    expect(source).not.toContain(`${join(configRoot, 'opencode', 'config', 'opencode', 'skills')}`)
    expect(source).not.toContain(`${join(configRoot, 'codex', 'skills')}`)
    expect(source).not.toContain(`${join(configRoot, 'codex-subscription', 'skills')}`)
  })

  it('routes every production source consumer through the one path owner', () => {
    const sources = productionSources()
    const consumers = sources
      .filter((path) => readSource(path).includes('connectorSkillSourceRoot'))
      .map(portablePath)

    expect(consumers).toEqual([
      'src/main/connectors/skill-source.ts',
      'src/main/ipc.ts',
      'src/main/settings/agent-runtime-manager.ts'
    ])
    expect(
      sources
        .filter((path) => readSource(path).includes('new ConnectorRuntimeSettingsProjection'))
        .map(portablePath)
    ).toEqual(['src/main/ipc.ts'])

    const ipc = readSource(resolve(projectRoot, 'src/main/ipc.ts'))
    expect(ipc).toContain('skillsDir: connectorSkillSourceRoot(resolveStorageRoot())')
    expect(ipc).not.toContain('skillsDir: join(getAppClaudeConfigDir(resolveStorageRoot())')

    const runtimeManager = readSource(
      resolve(projectRoot, 'src/main/settings/agent-runtime-manager.ts')
    )
    expect(runtimeManager).toContain(
      "join(connectorSkillSourceRoot(storageRoot), skillName, 'SKILL.md')"
    )
    expect(runtimeManager).not.toContain(
      "join(getAppClaudeConfigDir(storageRoot), 'skills', skillName, 'SKILL.md')"
    )
  })
})
