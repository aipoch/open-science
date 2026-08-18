import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ClaudeCodeSkillMaterializer } from '../skills/materializer'
import type { BundledSkill } from '../skills/registry'

const renameSourceModes = vi.hoisted(() => [] as number[])

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>): Promise<void> => {
      const source = await actual.lstat(args[0])
      renameSourceModes.push(source.mode & 0o777)
      if (!(source.mode & 0o200)) {
        throw Object.assign(new Error('macOS 14 rejects renaming a read-only directory'), {
          code: 'EACCES'
        })
      }
      await actual.rename(...args)
    }
  }
})

import {
  getClaudeSkillProjectionRevisionsDir,
  getClaudeSkillRuntimeRoot,
  provisionClaudeRuntime
} from './claude-runtime-provisioner'

let storageRoot: string | undefined

beforeEach(() => {
  renameSourceModes.length = 0
})

const makeWritable = async (root: string): Promise<void> => {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  await chmod(root, 0o755)
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name)
      if (entry.isDirectory()) await makeWritable(path)
      else if (!entry.isSymbolicLink()) await chmod(path, 0o644)
    })
  )
}

afterEach(async () => {
  if (!storageRoot) return
  await makeWritable(storageRoot)
  await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

const createStorageRoot = async (): Promise<string> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'os-claude-runtime-'))
  return storageRoot
}

const materializePlugin =
  (body = 'skill body') =>
  async (projectionRoot: string): Promise<void> => {
    await mkdir(join(projectionRoot, '.claude', 'skills', 'demo', 'scripts'), { recursive: true })
    await writeFile(
      join(projectionRoot, '.claude', 'skills', 'demo', 'SKILL.md'),
      `---\nname: demo\ndescription: Demo Skill.\n---\n${body}`,
      'utf8'
    )
    const script = join(projectionRoot, '.claude', 'skills', 'demo', 'scripts', 'run.sh')
    await writeFile(script, '#!/bin/sh\n', 'utf8')
    await chmod(script, 0o755)
  }

describe('provisionClaudeRuntime', () => {
  it('keeps private state disjoint from a canonical content-addressed, read-only projection', async () => {
    const root = await createStorageRoot()
    const provisionPrivateProfile = vi.fn(async (privateDir: string) => {
      await writeFile(join(privateDir, 'settings.json'), '{"private":true}\n', 'utf8')
      return { private: true }
    })

    const assets = await provisionClaudeRuntime({
      storageRoot: root,
      provisionPrivateProfile,
      materializeProjection: materializePlugin()
    })

    expect(assets.privateProfileDir).toBe(join(root, 'claude'))
    expect(assets.settingsPath).toBe(join(root, 'claude', 'settings.json'))
    expect(getClaudeSkillRuntimeRoot(root)).toBe(
      join(root, 'runtime-support', 'agent-skills', 'claude')
    )
    expect(assets.skillProjection.root).toBe(
      join(getClaudeSkillProjectionRevisionsDir(root), assets.skillProjection.revision)
    )
    expect(assets.skillProjection.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(relative(assets.privateProfileDir, assets.skillProjection.root)).toMatch(/^\.\./)
    expect(relative(assets.skillProjection.root, assets.privateProfileDir)).toMatch(/^\.\./)
    expect(provisionPrivateProfile).toHaveBeenCalledWith(assets.privateProfileDir)
    expect(assets.privateSettings).toEqual({ private: true })
    await expect(readFile(assets.settingsPath, 'utf8')).resolves.toContain('private')
    expect((await stat(assets.skillProjection.root)).mode & 0o222).toBe(0)
    expect(
      (await stat(join(assets.skillProjection.root, '.claude', 'skills', 'demo', 'SKILL.md')))
        .mode & 0o222
    ).toBe(0)
    if (process.platform !== 'win32') {
      expect(
        (
          await stat(
            join(assets.skillProjection.root, '.claude', 'skills', 'demo', 'scripts', 'run.sh')
          )
        ).mode & 0o111
      ).not.toBe(0)
    }
    expect(renameSourceModes).toHaveLength(1)
    expect(renameSourceModes[0] & 0o200).not.toBe(0)
  })

  it('rejects a symbolic-link private profile without changing its victim', async () => {
    const root = await createStorageRoot()
    const victim = join(root, 'victim-profile')
    await mkdir(join(victim, 'skills'), { recursive: true })
    await writeFile(join(victim, 'settings.json'), '{"victim":true}\n', 'utf8')
    await writeFile(join(victim, 'skills', 'sentinel'), 'untouched', 'utf8')
    await symlink(victim, join(root, 'claude'), process.platform === 'win32' ? 'junction' : 'dir')
    const materializeProjection = vi.fn(materializePlugin())

    await expect(
      provisionClaudeRuntime({ storageRoot: root, materializeProjection })
    ).rejects.toThrow('Claude private profile must be a real directory')

    expect(materializeProjection).not.toHaveBeenCalled()
    await expect(readFile(join(victim, 'settings.json'), 'utf8')).resolves.toBe('{"victim":true}\n')
    await expect(readFile(join(victim, 'skills', 'sentinel'), 'utf8')).resolves.toBe('untouched')
  })

  it('uses content and executable metadata for stable revisions', async () => {
    const root = await createStorageRoot()
    const first = await provisionClaudeRuntime({
      storageRoot: root,
      materializeProjection: materializePlugin('one')
    })
    const repeated = await provisionClaudeRuntime({
      storageRoot: root,
      materializeProjection: materializePlugin('one')
    })
    const changed = await provisionClaudeRuntime({
      storageRoot: root,
      materializeProjection: materializePlugin('two')
    })

    expect(repeated.skillProjection).toEqual(first.skillProjection)
    expect(changed.skillProjection.revision).not.toBe(first.skillProjection.revision)
    expect((await readdir(getClaudeSkillProjectionRevisionsDir(root))).sort()).toEqual(
      [first.skillProjection.revision, changed.skillProjection.revision].sort()
    )
  })

  it('publishes the same content safely under concurrent provisions', async () => {
    const root = await createStorageRoot()
    const [first, second] = await Promise.all([
      provisionClaudeRuntime({ storageRoot: root, materializeProjection: materializePlugin() }),
      provisionClaudeRuntime({ storageRoot: root, materializeProjection: materializePlugin() })
    ])

    expect(second.skillProjection).toEqual(first.skillProjection)
    expect(await readdir(getClaudeSkillProjectionRevisionsDir(root))).toEqual([
      first.skillProjection.revision
    ])
  })

  it('single-flights first-provision GC and retains every revision published by this process', async () => {
    const root = await createStorageRoot()
    const revisionsDir = getClaudeSkillProjectionRevisionsDir(root)
    await mkdir(join(revisionsDir, 'prior-process-revision'), { recursive: true })
    await writeFile(join(revisionsDir, 'prior-process-revision', 'stale'), 'stale', 'utf8')

    const [first, second] = await Promise.all([
      provisionClaudeRuntime({
        storageRoot: root,
        materializeProjection: materializePlugin('current one')
      }),
      provisionClaudeRuntime({
        storageRoot: root,
        materializeProjection: materializePlugin('current two')
      })
    ])

    expect((await readdir(revisionsDir)).sort()).toEqual(
      [first.skillProjection.revision, second.skillProjection.revision].sort()
    )

    const third = await provisionClaudeRuntime({
      storageRoot: root,
      materializeProjection: materializePlugin('current three')
    })
    expect((await readdir(revisionsDir)).sort()).toEqual(
      [
        first.skillProjection.revision,
        second.skillProjection.revision,
        third.skillProjection.revision
      ].sort()
    )
  })

  it('refuses to garbage-collect through a symlinked managed runtime ancestor', async () => {
    const root = await createStorageRoot()
    const outside = join(root, 'outside-runtime')
    const stale = join(outside, 'agent-skills', 'claude', 'v1', 'prior-revision')
    await mkdir(stale, { recursive: true })
    await writeFile(join(stale, 'sentinel'), 'outside', 'utf8')
    await symlink(
      outside,
      join(root, 'runtime-support'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    await expect(
      provisionClaudeRuntime({ storageRoot: root, materializeProjection: materializePlugin() })
    ).rejects.toThrow('runtime path must be a real directory')
    await expect(readFile(join(stale, 'sentinel'), 'utf8')).resolves.toBe('outside')
  })

  it('refuses to reuse a revision directory whose content was corrupted', async () => {
    const root = await createStorageRoot()
    const first = await provisionClaudeRuntime({
      storageRoot: root,
      materializeProjection: materializePlugin()
    })
    await makeWritable(first.skillProjection.root)
    await writeFile(
      join(first.skillProjection.root, '.claude', 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: Demo Skill.\n---\ncorrupt',
      'utf8'
    )

    await expect(
      provisionClaudeRuntime({ storageRoot: root, materializeProjection: materializePlugin() })
    ).rejects.toThrow('conflicting content')
  })

  it('restores read-only modes when reusing an otherwise unchanged revision', async () => {
    const root = await createStorageRoot()
    const first = await provisionClaudeRuntime({
      storageRoot: root,
      materializeProjection: materializePlugin()
    })
    const skillDocument = join(first.skillProjection.root, '.claude', 'skills', 'demo', 'SKILL.md')
    await chmod(first.skillProjection.root, 0o755)
    await chmod(skillDocument, 0o644)

    const repeated = await provisionClaudeRuntime({
      storageRoot: root,
      materializeProjection: materializePlugin()
    })

    expect(repeated.skillProjection).toEqual(first.skillProjection)
    expect((await stat(first.skillProjection.root)).mode & 0o222).toBe(0)
    expect((await stat(skillDocument)).mode & 0o222).toBe(0)
  })

  it('rejects a symbolic-link published revision root', async () => {
    const root = await createStorageRoot()
    const first = await provisionClaudeRuntime({
      storageRoot: root,
      materializeProjection: materializePlugin()
    })
    const outside = join(root, 'outside-revision')
    await mkdir(outside)
    await makeWritable(first.skillProjection.root)
    await rm(first.skillProjection.root, { recursive: true })
    await symlink(
      outside,
      first.skillProjection.root,
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    await expect(
      provisionClaudeRuntime({ storageRoot: root, materializeProjection: materializePlugin() })
    ).rejects.toThrow('revision cannot be a symbolic link')
  })

  it('migrates app-owned bundled and custom Skills while preserving unknown private Skills', async () => {
    const root = await createStorageRoot()
    const privateSkills = join(root, 'claude', 'skills')
    await mkdir(join(privateSkills, 'os-obsolete'), { recursive: true })
    await mkdir(join(privateSkills, 'user-skill'), { recursive: true })
    await mkdir(join(privateSkills, 'mcp-PubMed'), { recursive: true })
    await mkdir(join(privateSkills, 'mcp-custom'), { recursive: true })
    await mkdir(join(privateSkills, 'mcp-unknown'), { recursive: true })
    await mkdir(join(privateSkills, 'mcp-spoofed'), { recursive: true })
    await writeFile(join(privateSkills, 'os-obsolete', 'SKILL.md'), 'old', 'utf8')
    await writeFile(join(privateSkills, 'user-skill', 'SKILL.md'), 'mine', 'utf8')
    await writeFile(join(privateSkills, 'mcp-PubMed', 'SKILL.md'), 'legacy bundled', 'utf8')
    await writeFile(
      join(privateSkills, 'mcp-custom', 'SKILL.md'),
      '---\nname: mcp-custom\nsource: connector\n---\nlegacy custom',
      'utf8'
    )
    await writeFile(join(privateSkills, 'mcp-unknown', 'SKILL.md'), 'user content', 'utf8')
    await writeFile(
      join(privateSkills, 'mcp-spoofed', 'SKILL.md'),
      '---\nname: something-else\nsource: connector\n---\nuser content',
      'utf8'
    )

    await provisionClaudeRuntime({ storageRoot: root, materializeProjection: materializePlugin() })

    expect((await readdir(privateSkills)).sort()).toEqual(
      ['mcp-spoofed', 'mcp-unknown', 'user-skill'].sort()
    )
    await expect(readFile(join(privateSkills, 'user-skill', 'SKILL.md'), 'utf8')).resolves.toBe(
      'mine'
    )
  })

  it('does not migrate legacy Skills until a projection has published successfully', async () => {
    const root = await createStorageRoot()
    const legacySkill = join(root, 'claude', 'skills', 'os-obsolete')
    await mkdir(legacySkill, { recursive: true })
    await writeFile(join(legacySkill, 'SKILL.md'), 'old', 'utf8')

    await expect(
      provisionClaudeRuntime({
        storageRoot: root,
        materializeProjection: async () => {
          throw new Error('projection failed')
        }
      })
    ).rejects.toThrow('projection failed')
    await expect(readFile(join(legacySkill, 'SKILL.md'), 'utf8')).resolves.toBe('old')

    await provisionClaudeRuntime({ storageRoot: root, materializeProjection: materializePlugin() })
    await expect(stat(legacySkill)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('single-flights concurrent legacy cleanup and treats disappearing entries idempotently', async () => {
    const root = await createStorageRoot()
    const legacySkill = join(root, 'claude', 'skills', 'os-obsolete')
    await mkdir(legacySkill, { recursive: true })
    await writeFile(join(legacySkill, 'SKILL.md'), 'old', 'utf8')

    await expect(
      Promise.all([
        provisionClaudeRuntime({ storageRoot: root, materializeProjection: materializePlugin() }),
        provisionClaudeRuntime({ storageRoot: root, materializeProjection: materializePlugin() })
      ])
    ).resolves.toHaveLength(2)
    await expect(stat(legacySkill)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed when the legacy Skills root is a symbolic link', async () => {
    const root = await createStorageRoot()
    const outside = join(root, 'outside-skills')
    const privateProfile = join(root, 'claude')
    await mkdir(join(outside, 'os-obsolete'), { recursive: true })
    await mkdir(privateProfile, { recursive: true })
    await writeFile(join(outside, 'os-obsolete', 'SKILL.md'), 'outside', 'utf8')
    await symlink(
      outside,
      join(privateProfile, 'skills'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    await expect(
      provisionClaudeRuntime({ storageRoot: root, materializeProjection: materializePlugin() })
    ).rejects.toThrow('Legacy Claude Skills root must be a real directory')
    await expect(readFile(join(outside, 'os-obsolete', 'SKILL.md'), 'utf8')).resolves.toBe(
      'outside'
    )
    expect(await readdir(getClaudeSkillProjectionRevisionsDir(root))).toHaveLength(1)
  })

  it('fails closed on a symlink nested inside an app-owned legacy Skill', async () => {
    const root = await createStorageRoot()
    const outside = join(root, 'outside-skill-data')
    const legacySkill = join(root, 'claude', 'skills', 'os-obsolete')
    await mkdir(outside, { recursive: true })
    await mkdir(legacySkill, { recursive: true })
    await writeFile(join(outside, 'sentinel'), 'outside', 'utf8')
    await symlink(
      outside,
      join(legacySkill, 'references'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    await expect(
      provisionClaudeRuntime({ storageRoot: root, materializeProjection: materializePlugin() })
    ).rejects.toThrow('through symbolic link')
    await expect(readFile(join(outside, 'sentinel'), 'utf8')).resolves.toBe('outside')
    expect(await readdir(join(root, 'claude', 'skills'))).toContain('os-obsolete')
  })

  it('rejects an incomplete Agent-facing projection without exposing a partial revision', async () => {
    const root = await createStorageRoot()

    await expect(
      provisionClaudeRuntime({
        storageRoot: root,
        materializeProjection: async (projectionRoot) => {
          await mkdir(join(projectionRoot, 'skills'), { recursive: true })
        }
      })
    ).rejects.toThrow('Skill projection')

    expect(await readdir(getClaudeSkillProjectionRevisionsDir(root))).toEqual([])
  })

  it.each([
    ['without frontmatter', '# BioFlow transcriptomics\n'],
    ['with scalar frontmatter', '---\nlegacy\n---\n# BioFlow transcriptomics\n'],
    ['with array frontmatter', '---\n- legacy\n---\n# BioFlow transcriptomics\n'],
    ['with malformed frontmatter', '---\nname: [\n---\n# BioFlow transcriptomics\n']
  ])('publishes a canonical projection for a legacy imported Skill %s', async (_, document) => {
    const root = await createStorageRoot()
    const sourceDir = join(root, 'legacy-imported-skill')
    await mkdir(sourceDir)
    await writeFile(join(sourceDir, 'SKILL.md'), document, 'utf8')
    const skill: BundledSkill = {
      id: 'imported-bioflow-transcriptom',
      name: 'bioflow-transcriptom',
      displayName: 'BioFlow transcriptomics',
      description: '',
      source: 'imported',
      updatedAt: 'legacy',
      sourceDir
    }

    const assets = await provisionClaudeRuntime({
      storageRoot: root,
      materializeProjection: async (projectionRoot) => {
        await new ClaudeCodeSkillMaterializer().sync(join(projectionRoot, '.claude'), [skill], {
          directoryLayout: 'agent-facing'
        })
      }
    })

    await expect(
      readFile(
        join(assets.skillProjection.root, '.claude', 'skills', 'bioflow-transcriptom', 'SKILL.md'),
        'utf8'
      )
    ).resolves.toBe(
      '---\nname: bioflow-transcriptom\ndescription: BioFlow transcriptomics\n---\n# BioFlow transcriptomics\n'
    )
    await expect(readFile(join(sourceDir, 'SKILL.md'), 'utf8')).resolves.toBe(document)
  })

  it.each(['root CLAUDE.md', 'root hooks', '.claude settings.json', '.claude hooks'])(
    'rejects %s in an additional-directory Skill projection',
    async (kind) => {
      const root = await createStorageRoot()

      await expect(
        provisionClaudeRuntime({
          storageRoot: root,
          materializeProjection: async (projectionRoot) => {
            await materializePlugin()(projectionRoot)
            if (kind.startsWith('root ')) {
              const component = kind.slice('root '.length)
              if (component.includes('.'))
                await writeFile(join(projectionRoot, component), 'unsafe', 'utf8')
              else await mkdir(join(projectionRoot, component))
            } else {
              const component = kind.slice('.claude '.length)
              if (component.includes('.'))
                await writeFile(join(projectionRoot, '.claude', component), 'unsafe', 'utf8')
              else await mkdir(join(projectionRoot, '.claude', component))
            }
          }
        })
      ).rejects.toThrow('Skill projection')
    }
  )

  it.each([
    ['---', '---'],
    ['a--b', 'a--b'],
    ['os-private', 'os-private'],
    ['mcp-private', 'mcp-private'],
    ['a'.repeat(65), 'a'.repeat(65)],
    ['demo', 'different-name']
  ])('rejects non-canonical projected Skill directory %s', async (directory, name) => {
    const root = await createStorageRoot()

    await expect(
      provisionClaudeRuntime({
        storageRoot: root,
        materializeProjection: async (projectionRoot) => {
          const skillDir = join(projectionRoot, '.claude', 'skills', directory)
          await mkdir(skillDir, { recursive: true })
          await writeFile(
            join(skillDir, 'SKILL.md'),
            `---\nname: ${name}\ndescription: Invalid identity.\n---\nBody`,
            'utf8'
          )
        }
      })
    ).rejects.toThrow('canonical frontmatter name')
  })

  it('accepts a canonical Connector identity with a bundled underscore', async () => {
    const root = await createStorageRoot()

    const assets = await provisionClaudeRuntime({
      storageRoot: root,
      materializeProjection: async (projectionRoot) => {
        const skillDir = join(projectionRoot, '.claude', 'skills', 'mcp-human-genetics')
        await mkdir(skillDir, { recursive: true })
        await writeFile(
          join(skillDir, 'SKILL.md'),
          '---\nname: mcp-human-genetics\ndescription: Human genetics.\nsource: connector\n---\nBody',
          'utf8'
        )
      }
    })

    await expect(
      readFile(
        join(assets.skillProjection.root, '.claude', 'skills', 'mcp-human-genetics', 'SKILL.md'),
        'utf8'
      )
    ).resolves.toContain('source: connector')
  })
})
