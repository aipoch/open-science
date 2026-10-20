import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { BundledSkill } from '@aipoch/skills'
import { ClaudeCodeSkillMaterializer } from '@aipoch/skills/projection'

const roots: string[] = []
afterEach(async () => {
  const writable = async (directory: string): Promise<void> => {
    await chmod(directory, 0o755)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await writable(path)
      else if (!entry.isSymbolicLink()) await chmod(path, 0o644)
    }
  }
  for (const root of roots.splice(0)) {
    await writable(root)
    await rm(root, { recursive: true, force: true })
  }
})

const makeSkill = async (name: string): Promise<BundledSkill> => {
  const root = await mkdtemp(join(tmpdir(), `src-${name}-`))
  roots.push(root)
  await mkdir(join(root, 'scripts'), { recursive: true })
  await writeFile(join(root, 'SKILL.md'), `# ${name}`, 'utf8')
  await writeFile(join(root, 'scripts', 'main.py'), 'print(1)', 'utf8')
  return {
    id: name,
    name,
    displayName: name,
    description: '',
    source: 'featured',
    updatedAt: '',
    sourceDir: root
  }
}

const skillsDir = async (): Promise<string> => {
  const configDir = await mkdtemp(join(tmpdir(), 'cfg-'))
  roots.push(configDir)
  await mkdir(join(configDir, 'skills'), { recursive: true })
  return configDir
}

// Lists materialized skill dirs, ignoring the internal version manifest dotfile.
const listSkillDirs = async (configDir: string): Promise<string[]> =>
  (await readdir(join(configDir, 'skills'))).filter((name) => !name.startsWith('.'))

describe('ClaudeCodeSkillMaterializer', () => {
  it('uses canonical public names without app-owned markers for an Agent-facing projection', async () => {
    const configDir = await skillsDir()
    const skill = await makeSkill('paper-review')
    skill.id = 'imported-paper-review'
    await writeFile(
      join(skill.sourceDir, 'SKILL.md'),
      '---\nname: paper-review\ndescription: Review papers.\n---\nReview.',
      'utf8'
    )

    const materializer = new ClaudeCodeSkillMaterializer()
    await materializer.sync(configDir, [skill], {
      directoryLayout: 'agent-facing'
    })
    await materializer.sync(configDir, [skill], { directoryLayout: 'agent-facing' })

    expect(await listSkillDirs(configDir)).toEqual(['paper-review'])
    await expect(
      readFile(join(configDir, 'skills', 'paper-review', 'SKILL.md'), 'utf8')
    ).resolves.toContain('name: paper-review')
    await expect(stat(join(configDir, 'skills', '.os-versions.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    })

    await materializer.sync(configDir, [], { directoryLayout: 'agent-facing' })
    expect(await listSkillDirs(configDir)).toEqual([])
  })

  it.each(['---', 'a--b', 'a'.repeat(65), 'os-private', 'mcp-private'])(
    'rejects non-canonical Agent-facing Skill name %s',
    async (name) => {
      const configDir = await skillsDir()
      const skill = await makeSkill('safe-source')
      skill.name = name

      await expect(
        new ClaudeCodeSkillMaterializer().sync(configDir, [skill], {
          directoryLayout: 'agent-facing'
        })
      ).rejects.toThrow('unsafe Agent-facing Skill name')
    }
  )

  it('copies enabled skills into os-<id> dirs including subdirectories', async () => {
    const configDir = await skillsDir()
    const skill = await makeSkill('alpha')
    await new ClaudeCodeSkillMaterializer().sync(configDir, [skill])

    expect(await listSkillDirs(configDir)).toEqual(['os-alpha'])
    expect(
      await readFile(join(configDir, 'skills', 'os-alpha', 'scripts', 'main.py'), 'utf8')
    ).toBe('print(1)')
  })

  it('preserves the internal catalog stamp while filtering package metadata', async () => {
    const configDir = await skillsDir()
    const skill = await makeSkill('catalog-stamped')
    await writeFile(join(skill.sourceDir, '.catalog_stamp'), 'catalog-stamp', 'utf8')
    await writeFile(join(skill.sourceDir, '.gitignore'), 'ignored', 'utf8')

    await new ClaudeCodeSkillMaterializer().sync(configDir, [skill], {
      directoryLayout: 'app-owned'
    })

    await expect(
      readFile(join(configDir, 'skills', 'os-catalog-stamped', '.catalog_stamp'), 'utf8')
    ).resolves.toBe('catalog-stamp')
    await expect(
      readFile(join(configDir, 'skills', 'os-catalog-stamped', '.gitignore'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the runtime directory keyed by local id while normalizing SKILL.md to name', async () => {
    const configDir = await skillsDir()
    const skill = await makeSkill('paper-review')
    skill.id = 'imported-paper-review'
    await writeFile(
      join(skill.sourceDir, 'SKILL.md'),
      '---\nname: Legacy Paper Review\ndescription: Review papers.\n---\nReview.',
      'utf8'
    )

    await new ClaudeCodeSkillMaterializer().sync(configDir, [skill])

    expect(await listSkillDirs(configDir)).toEqual(['os-imported-paper-review'])
    expect(
      await readFile(join(configDir, 'skills', 'os-imported-paper-review', 'SKILL.md'), 'utf8')
    ).toContain('name: paper-review')
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

  it('re-copies when content compatibility changes even if updatedAt does not', async () => {
    const configDir = await skillsDir()
    const skill = {
      ...(await makeSkill('gamma')),
      updatedAt: 'v1',
      compatibility: 'sha256:v1'
    }
    const materializer = new ClaudeCodeSkillMaterializer()

    await materializer.sync(configDir, [skill])
    expect(await readFile(join(configDir, 'skills', 'os-gamma', 'SKILL.md'), 'utf8')).toBe(
      '# gamma'
    )

    // A source edit with an unchanged fingerprint is skipped.
    await writeFile(join(skill.sourceDir, 'SKILL.md'), '# gamma edited', 'utf8')
    await materializer.sync(configDir, [skill])
    expect(await readFile(join(configDir, 'skills', 'os-gamma', 'SKILL.md'), 'utf8')).toBe(
      '# gamma'
    )

    // Registry compatibility tracks content, so a new fingerprint refreshes the materialized copy
    // even when human-maintained updatedAt metadata was not bumped.
    await materializer.sync(configDir, [{ ...skill, compatibility: 'sha256:v2' }])
    expect(await readFile(join(configDir, 'skills', 'os-gamma', 'SKILL.md'), 'utf8')).toBe(
      '# gamma edited'
    )
  })

  it('refreshes an unchanged legacy projection whose frontmatter name is not canonical', async () => {
    const configDir = await skillsDir()
    const skill = {
      ...(await makeSkill('paper-review')),
      id: 'imported-paper-review',
      compatibility: 'sha256:v1'
    }
    await writeFile(
      join(skill.sourceDir, 'SKILL.md'),
      '---\nname: paper-review\ndescription: Review papers.\n---\nReview.',
      'utf8'
    )
    const materializer = new ClaudeCodeSkillMaterializer()
    await materializer.sync(configDir, [skill])

    const projectedDocument = join(configDir, 'skills', 'os-imported-paper-review', 'SKILL.md')
    await chmod(projectedDocument, 0o644)
    await writeFile(
      projectedDocument,
      '---\nname: imported-paper-review\ndescription: Review papers.\n---\nLegacy projection.',
      'utf8'
    )

    // The matching compatibility fingerprint normally skips the copy. A pre-refactor generated
    // projection with the local ID in frontmatter must instead be rebuilt from its source.
    await materializer.sync(configDir, [skill])

    const refreshed = await readFile(projectedDocument, 'utf8')
    expect(refreshed).toContain('name: paper-review')
    expect(refreshed).toContain('Review.')
    expect(refreshed).not.toContain('Legacy projection.')
  })

  it('materializes skill files with no write bits', async () => {
    const configDir = await skillsDir()
    const skill = await makeSkill('delta')
    await new ClaudeCodeSkillMaterializer().sync(configDir, [skill])

    const file = join(configDir, 'skills', 'os-delta', 'scripts', 'main.py')
    expect((await stat(file)).mode & 0o222).toBe(0)
  })

  it.skipIf(process.platform === 'win32')(
    'keeps executable scripts executable and ordinary files non-executable when read-only',
    async () => {
      const configDir = await skillsDir()
      const skill = { ...(await makeSkill('executable')), updatedAt: 'v1' }
      const sourceScript = join(skill.sourceDir, 'scripts', 'main.py')
      await chmod(sourceScript, 0o755)
      const materializer = new ClaudeCodeSkillMaterializer()

      await materializer.sync(configDir, [skill])
      // Exercise the unchanged fast path and its final read-only chmod pass as well.
      await materializer.sync(configDir, [skill])

      const target = join(configDir, 'skills', 'os-executable')
      const scriptMode = (await stat(join(target, 'scripts', 'main.py'))).mode & 0o777
      const documentMode = (await stat(join(target, 'SKILL.md'))).mode & 0o777
      expect(scriptMode).toBe(0o555)
      expect(documentMode).toBe(0o444)
    }
  )

  it('re-materializes despite a prior read-only state, leaving the new content read-only', async () => {
    const configDir = await skillsDir()
    const skill = { ...(await makeSkill('epsilon')), updatedAt: 'v1' }
    const materializer = new ClaudeCodeSkillMaterializer()

    await materializer.sync(configDir, [skill])
    const file = join(configDir, 'skills', 'os-epsilon', 'SKILL.md')
    expect((await stat(file)).mode & 0o222).toBe(0)

    // Change source content and bump the version: chmod-writable → rm → cp must succeed despite the
    // prior read-only dir, and the fresh copy is read-only again.
    await writeFile(join(skill.sourceDir, 'SKILL.md'), '# epsilon v2', 'utf8')
    await materializer.sync(configDir, [{ ...skill, updatedAt: 'v2' }])

    expect(await readFile(file, 'utf8')).toBe('# epsilon v2')
    expect((await stat(file)).mode & 0o222).toBe(0)
  })

  it('re-applies read-only to a skill skipped as unchanged, fixing an earlier writable materialize', async () => {
    const configDir = await skillsDir()
    const skill = { ...(await makeSkill('theta')), updatedAt: 'v1' }
    const materializer = new ClaudeCodeSkillMaterializer()

    await materializer.sync(configDir, [skill])
    const file = join(configDir, 'skills', 'os-theta', 'SKILL.md')

    // Simulate a dir left writable by an earlier version of the materializer.
    await chmod(file, 0o644)
    expect((await stat(file)).mode & 0o222).not.toBe(0)

    // Same version means the copy is skipped, but the final read-only pass still fixes the mode.
    await materializer.sync(configDir, [skill])
    expect((await stat(file)).mode & 0o222).toBe(0)
  })

  it('removes a read-only os- dir once the skill is disabled', async () => {
    const configDir = await skillsDir()
    const skill = await makeSkill('zeta')
    const materializer = new ClaudeCodeSkillMaterializer()

    await materializer.sync(configDir, [skill])
    // The materialized dir is read-only; a following empty sync must still remove it.
    await materializer.sync(configDir, [])

    expect(await listSkillDirs(configDir)).toEqual([])
  })
})

it.skipIf(process.platform === 'win32')(
  'omits a legacy imported Skill whose source tree contains a symlink',
  async () => {
    const configDir = await skillsDir()
    const skill = await makeSkill('linked')
    const outsideRoot = await mkdtemp(join(tmpdir(), 'outside-skill-'))
    roots.push(outsideRoot)
    const outside = join(outsideRoot, 'outside-secret.md')
    await writeFile(outside, 'outside secret')
    await symlink(outside, join(skill.sourceDir, 'scripts', 'outside.md'))

    await new ClaudeCodeSkillMaterializer().sync(configDir, [skill])

    expect(await listSkillDirs(configDir)).toEqual([])
  }
)
