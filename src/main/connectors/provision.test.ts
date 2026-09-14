import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncConnectorSkillDocs } from './provision'

describe('syncConnectorSkillDocs', () => {
  it('writes enabled connectors as mcp-<id>/SKILL.md and removes disabled ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skills-'))
    // A stale disabled connector directory that should be removed.
    await mkdir(join(dir, 'mcp-pubmed'), { recursive: true })
    await writeFile(join(dir, 'mcp-pubmed', 'SKILL.md'), 'stale')

    await syncConnectorSkillDocs(dir, ['chemistry', 'literature'])

    const entries = (await readdir(dir)).sort()
    expect(entries).toEqual(['mcp-chemistry', 'mcp-literature'])
    // Claude Code discovers skills as a directory containing SKILL.md.
    expect((await stat(join(dir, 'mcp-chemistry'))).isDirectory()).toBe(true)
    const doc = await readFile(join(dir, 'mcp-chemistry', 'SKILL.md'), 'utf8')
    expect(doc).toContain('name: mcp-chemistry')
    expect(doc).toContain('source: connector')
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
