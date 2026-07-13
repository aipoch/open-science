import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { BundledSkill } from './registry'
import { ClaudeCodeSkillMaterializer } from './materializer'

const makeSkill = async (name: string): Promise<BundledSkill> => {
  const root = await mkdtemp(join(tmpdir(), `src-${name}-`))
  await mkdir(join(root, 'scripts'), { recursive: true })
  await writeFile(join(root, 'SKILL.md'), `# ${name}`, 'utf8')
  await writeFile(join(root, 'scripts', 'main.py'), 'print(1)', 'utf8')
  return { id: name, name, description: '', source: 'featured', updatedAt: '', sourceDir: root }
}

const skillsDir = async (): Promise<string> => {
  const configDir = await mkdtemp(join(tmpdir(), 'cfg-'))
  await mkdir(join(configDir, 'skills'), { recursive: true })
  return configDir
}

// Lists materialized skill dirs, ignoring the internal version manifest dotfile.
const listSkillDirs = async (configDir: string): Promise<string[]> =>
  (await readdir(join(configDir, 'skills'))).filter((name) => !name.startsWith('.'))

describe('ClaudeCodeSkillMaterializer', () => {
  it('copies enabled skills into os-<id> dirs including subdirectories', async () => {
    const configDir = await skillsDir()
    const skill = await makeSkill('alpha')
    await new ClaudeCodeSkillMaterializer().sync(configDir, [skill])

    expect(await listSkillDirs(configDir)).toEqual(['os-alpha'])
    expect(
      await readFile(join(configDir, 'skills', 'os-alpha', 'scripts', 'main.py'), 'utf8')
    ).toBe('print(1)')
  })

  it('removes os- dirs that are no longer enabled but leaves other dirs untouched', async () => {
    const configDir = await skillsDir()
    await mkdir(join(configDir, 'skills', 'os-stale'), { recursive: true })
    await mkdir(join(configDir, 'skills', 'user-thing'), { recursive: true })
    await writeFile(join(configDir, 'skills', 'user-thing', 'keep.md'), 'keep', 'utf8')

    await new ClaudeCodeSkillMaterializer().sync(configDir, [])

    expect(await listSkillDirs(configDir)).toEqual(['user-thing'])
  })

  it('is idempotent and refreshes content on repeated sync', async () => {
    const configDir = await skillsDir()
    const skill = await makeSkill('beta')
    const materializer = new ClaudeCodeSkillMaterializer()
    await materializer.sync(configDir, [skill])
    await writeFile(join(skill.sourceDir, 'SKILL.md'), '# beta v2', 'utf8')
    await materializer.sync(configDir, [skill])

    expect(await readFile(join(configDir, 'skills', 'os-beta', 'SKILL.md'), 'utf8')).toBe(
      '# beta v2'
    )
    expect(await listSkillDirs(configDir)).toEqual(['os-beta'])
  })

  it('skips re-copying when updatedAt is unchanged and re-copies when it changes', async () => {
    const configDir = await skillsDir()
    const skill = { ...(await makeSkill('gamma')), updatedAt: 'v1' }
    const materializer = new ClaudeCodeSkillMaterializer()

    await materializer.sync(configDir, [skill])
    expect(await readFile(join(configDir, 'skills', 'os-gamma', 'SKILL.md'), 'utf8')).toBe(
      '# gamma'
    )

    // Change the source but keep the same version: the copy is skipped, so the target stays stale.
    await writeFile(join(skill.sourceDir, 'SKILL.md'), '# gamma edited', 'utf8')
    await materializer.sync(configDir, [skill])
    expect(await readFile(join(configDir, 'skills', 'os-gamma', 'SKILL.md'), 'utf8')).toBe(
      '# gamma'
    )

    // Bump the version: the skill is re-copied and the target refreshes.
    await materializer.sync(configDir, [{ ...skill, updatedAt: 'v2' }])
    expect(await readFile(join(configDir, 'skills', 'os-gamma', 'SKILL.md'), 'utf8')).toBe(
      '# gamma edited'
    )
  })
})
