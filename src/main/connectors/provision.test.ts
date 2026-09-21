import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, readdir, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncConnectorSkillDocs } from './provision'

describe('syncConnectorSkillDocs', () => {
  it.each(['zenodo', 'Zenodo'])(
    'preserves historical custom files for %s through enabled and disabled syncs',
    async (name) => {
      const dir = await mkdtemp(join(tmpdir(), 'skills-conflict-'))
      try {
        const target = join(dir, `mcp-${name}`)
        await mkdir(target)
        await writeFile(join(target, 'SKILL.md'), 'historical custom doc')
        await writeFile(join(target, 'attachment.txt'), 'user data')
        for (const enabled of [['zenodo', 'chemistry'], ['chemistry']]) {
          await syncConnectorSkillDocs(dir, enabled, ['zenodo'])
          expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('historical custom doc')
          expect(await readFile(join(target, 'attachment.txt'), 'utf8')).toBe('user data')
          expect(await readFile(join(dir, 'mcp-chemistry', 'SKILL.md'), 'utf8')).toContain(
            'name: mcp-chemistry'
          )
        }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  )

  it('writes enabled connectors as mcp-<id>/SKILL.md and removes disabled ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skills-'))
    // A stale disabled connector directory that should be removed.
    await mkdir(join(dir, 'mcp-pubmed'), { recursive: true })
    await writeFile(join(dir, 'mcp-pubmed', 'SKILL.md'), 'stale')

    await syncConnectorSkillDocs(dir, ['chemistry', 'literature', 'zenodo'])

    const entries = (await readdir(dir)).sort()
    expect(entries).toEqual(['mcp-chemistry', 'mcp-literature', 'mcp-zenodo'])
    // Claude Code discovers skills as a directory containing SKILL.md.
    expect((await stat(join(dir, 'mcp-chemistry'))).isDirectory()).toBe(true)
    const doc = await readFile(join(dir, 'mcp-chemistry', 'SKILL.md'), 'utf8')
    expect(doc).toContain('name: mcp-chemistry')
    expect(doc).toContain('source: connector')
    const zenodo = await readFile(join(dir, 'mcp-zenodo', 'SKILL.md'), 'utf8')
    expect(zenodo).toContain('### search_records')
    expect(zenodo).toContain('### get_record')
    const literature = await readFile(join(dir, 'mcp-literature', 'SKILL.md'), 'utf8')
    for (const method of [
      'crossref_get_work',
      'crossref_get_updates',
      'datacite_search_records',
      'datacite_get_record'
    ]) {
      expect(literature).toContain(`### ${method}`)
    }
  })
})
