import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DENIED_BUILTIN_TOOLS,
  MANAGED_BUILTIN_TOOLS,
  configDenyRules,
  provisionAppClaudePrivateProfile
} from './claude-config-provision'

vi.mock('electron', () => ({
  app: { getAppPath: () => join(tmpdir(), 'os-no-such-app-root') }
}))

let root: string | undefined

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

describe('built-in tool deny policy', () => {
  // Pruning-on-removal only re-enables a tool if it is in the module-owned superset. A tool denied
  // now but absent from MANAGED_BUILTIN_TOOLS would stay denied forever once later removed from
  // DENIED_BUILTIN_TOOLS — the exact bug the prune step fixes. Guard the DENIED ⊆ MANAGED invariant.
  it('keeps every denied built-in tool in the managed superset', () => {
    const managed = new Set<string>(MANAGED_BUILTIN_TOOLS)
    for (const tool of DENIED_BUILTIN_TOOLS) {
      expect(managed.has(tool)).toBe(true)
    }
  })
})

describe('provisionAppClaudePrivateProfile', () => {
  it('creates only the private profile and settings file', async () => {
    root = await mkdtemp(join(tmpdir(), 'os-claude-config-'))
    const configDir = join(root, 'claude')

    await provisionAppClaudePrivateProfile(configDir)

    expect((await stat(configDir)).isDirectory()).toBe(true)
    await expect(readFile(join(configDir, 'settings.json'), 'utf8')).resolves.toBeTruthy()
    await expect(stat(join(configDir, 'skills'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(configDir, '.claude-plugin'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('is idempotent', async () => {
    root = await mkdtemp(join(tmpdir(), 'os-claude-config-'))
    const configDir = join(root, 'claude')

    const first = await provisionAppClaudePrivateProfile(configDir)
    await expect(provisionAppClaudePrivateProfile(configDir)).resolves.toEqual(first)
  })

  it('writes permission deny rules fencing the file tools out of the config dir', async () => {
    root = await mkdtemp(join(tmpdir(), 'os-claude-config-'))
    const configDir = join(root, 'claude')

    await provisionAppClaudePrivateProfile(configDir)

    const settings = JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8'))
    const deny: string[] = settings.permissions.deny
    expect(deny).toEqual([...configDenyRules(configDir), ...DENIED_BUILTIN_TOOLS])
    // Each rule is an absolute-path (`//`) recursive deny for one of the guarded file tools.
    for (const tool of ['Read', 'Edit', 'Glob', 'Grep']) {
      expect(deny.some((rule) => rule.startsWith(`${tool}(//`) && rule.endsWith('/**)'))).toBe(true)
    }
  })

  it('returns the exact private settings snapshot written for session-scoped use', async () => {
    root = await mkdtemp(join(tmpdir(), 'os-claude-config-'))
    const configDir = join(root, 'claude')

    const settings = await provisionAppClaudePrivateProfile(configDir)

    expect(settings).toEqual(JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8')))
    expect(settings).toMatchObject({ disableBundledSkills: true })
  })

  it('leaves the built-in web tools enabled in the app user scope', async () => {
    root = await mkdtemp(join(tmpdir(), 'os-claude-config-'))
    const configDir = join(root, 'claude')

    await provisionAppClaudePrivateProfile(configDir)

    const settings = JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8'))
    expect(settings.permissions.deny).not.toContain('WebSearch')
    expect(settings.permissions.deny).not.toContain('WebFetch')
  })

  it('prunes a persisted managed built-in deny (WebSearch) on upgrade, keeping unrelated rules', async () => {
    root = await mkdtemp(join(tmpdir(), 'os-claude-config-'))
    const configDir = join(root, 'claude')
    await mkdir(configDir, { recursive: true })
    // Simulate an install provisioned before this change: WebSearch already persisted alongside an
    // unrelated user deny rule.
    await writeFile(
      join(configDir, 'settings.json'),
      JSON.stringify({ permissions: { deny: ['WebSearch', 'Bash(rm:*)'] } }),
      'utf8'
    )

    await provisionAppClaudePrivateProfile(configDir)

    const settings = JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8'))
    expect(settings.permissions.deny).not.toContain('WebSearch')
    expect(settings.permissions.deny).toContain('Bash(rm:*)')
  })

  it('disables Claude Code bundled skills in the app user scope', async () => {
    root = await mkdtemp(join(tmpdir(), 'os-claude-config-'))
    const configDir = join(root, 'claude')

    await provisionAppClaudePrivateProfile(configDir)

    const settings = JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8'))
    expect(settings.disableBundledSkills).toBe(true)
  })

  it('merges guard deny rules into a pre-existing settings.json without dropping entries', async () => {
    root = await mkdtemp(join(tmpdir(), 'os-claude-config-'))
    const configDir = join(root, 'claude')
    await mkdir(configDir, { recursive: true })
    await writeFile(
      join(configDir, 'settings.json'),
      JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] }, model: 'keep-me' }),
      'utf8'
    )

    await provisionAppClaudePrivateProfile(configDir)

    const settings = JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8'))
    expect(settings.model).toBe('keep-me')
    expect(settings.disableBundledSkills).toBe(true)
    expect(settings.permissions.deny).toContain('Bash(rm:*)')
    for (const rule of configDenyRules(configDir)) {
      expect(settings.permissions.deny).toContain(rule)
    }
  })

  it('projects and explicitly clears the app-owned model catalog', async () => {
    root = await mkdtemp(join(tmpdir(), 'os-claude-config-'))
    const configDir = join(root, 'claude')

    await provisionAppClaudePrivateProfile(configDir, {
      availableModels: ['sonnet', 'opus'],
      modelOverrides: {
        sonnet: 'deepseek-v4-flash',
        opus: 'deepseek-v4-pro'
      }
    })

    expect(JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8'))).toMatchObject({
      availableModels: ['sonnet', 'opus'],
      modelOverrides: {
        sonnet: 'deepseek-v4-flash',
        opus: 'deepseek-v4-pro'
      }
    })

    await provisionAppClaudePrivateProfile(configDir, null)

    const cleared = JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8'))
    expect(cleared.availableModels).toBeUndefined()
    expect(cleared.modelOverrides).toBeUndefined()
    expect(cleared.permissions.deny).toEqual(configDenyRules(configDir))
    expect(cleared.disableBundledSkills).toBe(true)
  })
})
