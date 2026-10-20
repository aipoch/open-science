import { chmod, mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { COMPUTE_SKILL_DIRECTORY } from '../compute/skill-doc'
import type { BundledSkill } from '@aipoch/skills'
import { ClaudeCodeSkillMaterializer } from './materializer'

const skillsDir = async (): Promise<string> => {
  const configDir = await mkdtemp(join(tmpdir(), 'cfg-'))
  await mkdir(join(configDir, 'skills'), { recursive: true })
  return configDir
}

// Lists materialized skill dirs, ignoring the internal version manifest dotfile.
const listSkillDirs = async (configDir: string): Promise<string[]> =>
  (await readdir(join(configDir, 'skills'))).filter((name) => !name.startsWith('.'))

describe('ClaudeCodeSkillMaterializer', () => {
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
