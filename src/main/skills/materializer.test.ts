import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { COMPUTE_SKILL_DIRECTORY } from '../compute/skill-doc'
import type { BundledSkill } from './registry'
import { ClaudeCodeSkillMaterializer } from './materializer'

const makeSkill = async (name: string): Promise<BundledSkill> => {
  const root = await mkdtemp(join(tmpdir(), `src-${name}-`))
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

    await new ClaudeCodeSkillMaterializer().sync(configDir, [skill], {
      directoryLayout: 'agent-facing'
    })

    expect(await listSkillDirs(configDir)).toEqual(['paper-review'])
    await expect(
      readFile(join(configDir, 'skills', 'paper-review', 'SKILL.md'), 'utf8')
    ).resolves.toContain('name: paper-review')
    await expect(stat(join(configDir, 'skills', '.os-versions.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
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

  it('refreshes Remote Compute from bundled static content without preserving host projection', async () => {
    const configDir = await skillsDir()
    const sourceDir = await mkdtemp(join(tmpdir(), 'src-remote-compute-ssh-'))
    await writeFile(
      join(sourceDir, 'SKILL.md'),
      [
        '---',
        'name: remote-compute-ssh',
        'description: Discover SSH compute hosts.',
        '---',
        '',
        '## Registered hosts',
        '',
        'Run `await host.compute.listRegistered()` to see all registered hosts.',
        '',
        '## API reference',
        '',
        'Bundled SSH guidance.'
      ].join('\n'),
      'utf8'
    )
    const computeSkill: BundledSkill = {
      id: 'remote-compute-ssh',
      name: 'remote-compute-ssh',
      displayName: 'Remote Compute (SSH)',
      description: 'Discover SSH compute hosts.',
      source: 'featured',
      updatedAt: 'v1',
      sourceDir
    }
    const materializer = new ClaudeCodeSkillMaterializer()

    await materializer.sync(configDir, [computeSkill])
    await chmod(join(configDir, 'skills', COMPUTE_SKILL_DIRECTORY), 0o755)
    await chmod(join(configDir, 'skills', COMPUTE_SKILL_DIRECTORY, 'SKILL.md'), 0o644)
    await writeFile(
      join(configDir, 'skills', COMPUTE_SKILL_DIRECTORY, 'SKILL.md'),
      '---\nname: remote-compute-ssh\ndescription: stale\n---\n\nssh:biowulf\n',
      'utf8'
    )

    await materializer.sync(configDir, [{ ...computeSkill, updatedAt: 'v2' }])

    const doc = await readFile(
      join(configDir, 'skills', COMPUTE_SKILL_DIRECTORY, 'SKILL.md'),
      'utf8'
    )
    const secondConfigDir = await skillsDir()
    await materializer.sync(secondConfigDir, [{ ...computeSkill, updatedAt: 'v2' }])
    const secondDoc = await readFile(
      join(secondConfigDir, 'skills', COMPUTE_SKILL_DIRECTORY, 'SKILL.md'),
      'utf8'
    )
    expect(doc).not.toContain('ssh:biowulf')
    expect(doc).not.toContain('open-science:compute-hosts')
    expect(doc).toContain('Bundled SSH guidance.')
    expect(secondDoc).toBe(doc)
  })

  it('removes only the known legacy bare Compute Skill directory', async () => {
    const configDir = await skillsDir()
    await mkdir(join(configDir, 'skills', 'remote-compute-ssh'), { recursive: true })
    await writeFile(join(configDir, 'skills', 'remote-compute-ssh', 'SKILL.md'), 'legacy')
    await mkdir(join(configDir, 'skills', 'user-owned-skill'), { recursive: true })
    await writeFile(join(configDir, 'skills', 'user-owned-skill', 'SKILL.md'), 'user-owned')

    await new ClaudeCodeSkillMaterializer().sync(configDir, [])

    expect(await listSkillDirs(configDir)).toEqual(['user-owned-skill'])
  })

  it.skipIf(process.platform === 'win32')(
    'omits a legacy imported Skill whose source tree contains a symlink',
    async () => {
      const configDir = await skillsDir()
      const skill = await makeSkill('linked')
      const outsideRoot = await mkdtemp(join(tmpdir(), 'outside-skill-'))
      const outside = join(outsideRoot, 'outside-secret.md')
      await writeFile(outside, 'outside secret')
      await symlink(outside, join(skill.sourceDir, 'scripts', 'outside.md'))

      await new ClaudeCodeSkillMaterializer().sync(configDir, [skill])

      expect(await listSkillDirs(configDir)).toEqual([])
    }
  )

  // Builds a source skill with a real frontmatter block so the notice injection has a header to sit
  // after; category/requirements are set on the returned object (the predicate reads those fields).
  const makeSkillWithFrontmatter = async (
    name: string,
    extra: Partial<BundledSkill>
  ): Promise<BundledSkill> => {
    const root = await mkdtemp(join(tmpdir(), `src-${name}-`))
    await writeFile(
      join(root, 'SKILL.md'),
      ['---', `name: ${name}`, 'description: does a thing', '---', '', '# Heading', 'Run it.'].join(
        '\n'
      ),
      'utf8'
    )
    return {
      id: name,
      name,
      description: '',
      source: 'featured',
      updatedAt: '',
      sourceDir: root,
      ...extra,
      displayName: extra.displayName ?? name
    }
  }

  it('injects the compute-unavailable notice for a biomodels-category skill, keeping frontmatter first', async () => {
    const configDir = await skillsDir()
    const skill = await makeSkillWithFrontmatter('alphafold2', { category: 'biomodels' })
    await new ClaudeCodeSkillMaterializer().sync(configDir, [skill])

    const md = await readFile(join(configDir, 'skills', 'os-alphafold2', 'SKILL.md'), 'utf8')
    expect(md.startsWith('---\n')).toBe(true) // YAML header still first
    expect(md).toContain('Compute environment unavailable in this app')
    // notice sits between the frontmatter and the body heading
    expect(md.indexOf('Compute environment unavailable')).toBeLessThan(md.indexOf('# Heading'))
  })

  it('injects for a gpu requirement even without a category, and not for a pure skill', async () => {
    const configDir = await skillsDir()
    const gpu = await makeSkillWithFrontmatter('scvi-tools', { requirements: '[gpu]' })
    const pure = await makeSkillWithFrontmatter('literature-review', {})
    await new ClaudeCodeSkillMaterializer().sync(configDir, [gpu, pure])

    const gpuMd = await readFile(join(configDir, 'skills', 'os-scvi-tools', 'SKILL.md'), 'utf8')
    const pureMd = await readFile(
      join(configDir, 'skills', 'os-literature-review', 'SKILL.md'),
      'utf8'
    )
    expect(gpuMd).toContain('Compute environment unavailable in this app')
    expect(pureMd).not.toContain('Compute environment unavailable in this app')
  })

  it('does not double-inject the notice on a version-bump re-copy', async () => {
    const configDir = await skillsDir()
    const skill = {
      ...(await makeSkillWithFrontmatter('boltz', { category: 'biomodels' })),
      updatedAt: 'v1'
    }
    const materializer = new ClaudeCodeSkillMaterializer()
    await materializer.sync(configDir, [skill])
    await materializer.sync(configDir, [{ ...skill, updatedAt: 'v2' }])

    const md = await readFile(join(configDir, 'skills', 'os-boltz', 'SKILL.md'), 'utf8')
    const occurrences = md.split('Compute environment unavailable in this app').length - 1
    expect(occurrences).toBe(1)
  })
})
