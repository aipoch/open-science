import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SKILL_IMPORT_LIMITS } from '../../shared/skill-import-limits'
import { listSkillFiles } from './skill-files'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const skillRoot = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

describe('listSkillFiles', () => {
  it('recursively lists files across skill directories with posix paths and sizes', async () => {
    const root = await skillRoot('skill-files-tree-')
    await writeFile(join(root, 'SKILL.md'), '# Skill')
    await mkdir(join(root, 'references'), { recursive: true })
    await mkdir(join(root, 'scripts', 'helpers'), { recursive: true })
    await mkdir(join(root, 'assets'), { recursive: true })
    await mkdir(join(root, 'templates'), { recursive: true })
    await writeFile(join(root, 'references', 'dataset.csv'), 'csv-bytes')
    await writeFile(join(root, 'scripts', 'run.py'), 'python')
    await writeFile(join(root, 'scripts', 'helpers', 'utils.py'), 'util')
    await writeFile(join(root, 'assets', 'model.bin'), 'bin')
    await writeFile(join(root, 'templates', 'report.md'), 'report')
    await writeFile(join(root, 'requirements.txt'), 'reqs')

    const files = await listSkillFiles(root)
    expect(files.map((file) => file.path)).toEqual([
      'assets/model.bin',
      'references/dataset.csv',
      'requirements.txt',
      'scripts/helpers/utils.py',
      'scripts/run.py',
      'templates/report.md'
    ])
    expect(files.find((file) => file.path === 'scripts/run.py')?.size).toBe('python'.length)
  })

  it('omits SKILL.md (already rendered as the body)', async () => {
    const root = await skillRoot('skill-files-skipmd-')
    await writeFile(join(root, 'SKILL.md'), '# Skill')
    await mkdir(join(root, 'references'), { recursive: true })
    await writeFile(join(root, 'references', 'note.md'), 'note')

    const files = await listSkillFiles(root)
    expect(files.map((file) => file.path)).toEqual(['references/note.md'])
  })

  it.each(['skill.md', 'Skill.md', 'SKILL.MD'])(
    'omits the skill document regardless of filename case (%s)',
    async (filename) => {
      const root = await skillRoot('skill-files-skipmd-case-')
      await writeFile(join(root, filename), '# Skill')
      await mkdir(join(root, 'references'), { recursive: true })
      await writeFile(join(root, 'references', 'note.md'), 'note')

      const files = await listSkillFiles(root)
      expect(files.map((file) => file.path)).toEqual(['references/note.md'])
    }
  )

  it('drops app metadata and dotfiles at the root but keeps a same-named file in a subdirectory', async () => {
    const root = await skillRoot('skill-files-metadata-')
    await writeFile(join(root, 'SKILL.md'), '# Skill')
    await writeFile(join(root, '.source.json'), '{}')
    await writeFile(join(root, '.specialist-package.json'), '{}')
    await writeFile(join(root, '.hidden'), 'secret')
    await mkdir(join(root, 'scripts'), { recursive: true })
    // A nested file whose basename collides with a root metadata file is kept: the relative path
    // does not start with '.', and the metadata exclusion only applies at the skill root.
    await writeFile(join(root, 'scripts', '.source.json'), '{}')
    await writeFile(join(root, 'scripts', 'run.py'), 'python')

    const files = await listSkillFiles(root)
    expect(files.map((file) => file.path)).toEqual(['scripts/.source.json', 'scripts/run.py'])
  })

  it('skips symbolic links instead of throwing', async () => {
    const root = await skillRoot('skill-files-symlink-')
    await writeFile(join(root, 'SKILL.md'), '# Skill')
    await mkdir(join(root, 'scripts'), { recursive: true })
    await writeFile(join(root, 'scripts', 'real.py'), 'real')
    await symlink(join(root, 'scripts', 'real.py'), join(root, 'scripts', 'link.py'))

    const files = await listSkillFiles(root)
    expect(files.map((file) => file.path)).toEqual(['scripts/real.py'])
  })

  it('skips entries deeper than the depth limit instead of throwing', async () => {
    const root = await skillRoot('skill-files-depth-')
    await writeFile(join(root, 'SKILL.md'), '# Skill')
    let current = root
    // Build a chain of 9 nested directories; the 9th sits beyond the depth limit.
    for (let index = 1; index <= 9; index += 1) {
      current = join(current, `n${index}`)
      await mkdir(current)
      await writeFile(join(current, 'file.txt'), 'x')
    }

    const files = await listSkillFiles(root)
    const paths = files.map((file) => file.path)
    expect(paths).toContain('n1/n2/n3/n4/n5/n6/n7/n8/file.txt')
    expect(paths).not.toContain('n1/n2/n3/n4/n5/n6/n7/n8/n9/file.txt')
  })

  it('caps the listing at the file-count limit without throwing', async () => {
    const root = await skillRoot('skill-files-maxfiles-')
    await writeFile(join(root, 'SKILL.md'), '# Skill')
    await mkdir(join(root, 'data'), { recursive: true })
    // One more than the cap; the excess file is skipped, not raised.
    for (let index = 0; index <= SKILL_IMPORT_LIMITS.maxFiles; index += 1) {
      await writeFile(join(root, 'data', `f${index}.txt`), 'x')
    }

    const files = await listSkillFiles(root)
    expect(files).toHaveLength(SKILL_IMPORT_LIMITS.maxFiles)
  })

  it('returns an empty list for a directory with only SKILL.md', async () => {
    const root = await skillRoot('skill-files-empty-')
    await writeFile(join(root, 'SKILL.md'), '# Skill')

    expect(await listSkillFiles(root)).toEqual([])
  })

  it('returns an empty list when the directory does not exist', async () => {
    expect(await listSkillFiles(join(tmpdir(), 'skill-files-missing-'))).toEqual([])
  })
})
