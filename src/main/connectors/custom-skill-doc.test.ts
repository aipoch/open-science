import { describe, it, expect } from 'vitest'
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderCustomSkillDoc } from './skill-doc'
import { syncConnectorSkillDocs, syncCustomServerSkillDocs } from './provision'
import type { StoredCustomMcpServer } from '../settings/types'

const FAKE_TOOLS = [
  { name: 'search', description: 'Search the corpus', inputSchema: { type: 'object' } },
  { name: 'fetch', description: 'Fetch one record' }
]

function makeServer(overrides: Partial<StoredCustomMcpServer> = {}): StoredCustomMcpServer {
  return {
    id: 'srv-1',
    name: 'myserver',
    transport: 'stdio',
    command: 'npx',
    enabled: true,
    ...overrides
  }
}

describe('renderCustomSkillDoc', () => {
  it('renders frontmatter, a composed "Use when" description, and each tool', () => {
    const md = renderCustomSkillDoc({ name: 'myserver' }, FAKE_TOOLS)
    expect(md).toContain('name: mcp-myserver')
    expect(md).toContain('source: connector')
    expect(md).toMatch(/description: ".*Use when.*"/)
    expect(md).toContain('## When to Use')
    expect(md).toContain('search')
    expect(md).toContain('fetch')
    expect(md).toContain('"type": "object"')
    // No-arg tools render without a third argument (a literal ... would reach the bridge as Ellipsis).
    expect(md).toContain('host.mcp("myserver", "search")')
    expect(md).toContain('host.mcp("myserver", "fetch")')
  })

  it('uses the server-provided description verbatim when present', () => {
    const md = renderCustomSkillDoc(
      { name: 'myserver', description: 'Use when the user asks about widgets.' },
      FAKE_TOOLS
    )
    const frontmatter = md.slice(0, md.indexOf('---', 3))
    expect(frontmatter).toContain('Use when the user asks about widgets.')
  })

  it('renders a concrete dict example from a custom tool inputSchema', () => {
    const md = renderCustomSkillDoc({ name: 'myserver' }, [
      {
        name: 'lookup',
        description: 'Look up a record',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' }, limit: { type: 'integer', default: 10 } },
          required: ['id']
        }
      }
    ])
    expect(md).toContain(
      'const result = await host.mcp("myserver", "lookup", {"id": "...", "limit": 10})'
    )
  })
})

describe('syncCustomServerSkillDocs', () => {
  it('writes mcp-<name>/SKILL.md for an enabled server and removes it once disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'custom-skills-'))
    const server = makeServer()
    const listTools = async (): Promise<typeof FAKE_TOOLS> => FAKE_TOOLS

    await syncCustomServerSkillDocs(dir, [server], listTools)

    let entries = (await readdir(dir)).sort()
    expect(entries).toEqual(['mcp-myserver'])
    expect((await stat(join(dir, 'mcp-myserver'))).isDirectory()).toBe(true)
    const doc = await readFile(join(dir, 'mcp-myserver', 'SKILL.md'), 'utf8')
    expect(doc).toContain('name: mcp-myserver')

    // Server no longer enabled -> its skill dir is removed.
    await syncCustomServerSkillDocs(dir, [], listTools)
    entries = (await readdir(dir)).sort()
    expect(entries).toEqual([])
  })
})

describe('bundled and custom skill-doc sync coexist', () => {
  it("do not delete each other's directories when run against the same skills dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coexist-skills-'))
    const server = makeServer({ name: 'myserver' })
    const listTools = async (): Promise<typeof FAKE_TOOLS> => FAKE_TOOLS

    await syncConnectorSkillDocs(dir, ['chemistry'])
    await syncCustomServerSkillDocs(dir, [server], listTools)

    let entries = (await readdir(dir)).sort()
    expect(entries).toEqual(['mcp-chemistry', 'mcp-myserver'])

    // Re-running the bundled sync must not remove the custom server's directory...
    await syncConnectorSkillDocs(dir, ['chemistry'])
    entries = (await readdir(dir)).sort()
    expect(entries).toEqual(['mcp-chemistry', 'mcp-myserver'])

    // ...and re-running the custom sync must not remove the bundled connector's directory.
    await syncCustomServerSkillDocs(dir, [server], listTools)
    entries = (await readdir(dir)).sort()
    expect(entries).toEqual(['mcp-chemistry', 'mcp-myserver'])

    // Disabling the bundled connector only removes the bundled dir, leaving the custom one intact.
    await syncConnectorSkillDocs(dir, [])
    entries = (await readdir(dir)).sort()
    expect(entries).toEqual(['mcp-myserver'])

    // And disabling the custom server only removes the custom dir.
    await syncConnectorSkillDocs(dir, ['chemistry'])
    await syncCustomServerSkillDocs(dir, [], listTools)
    entries = (await readdir(dir)).sort()
    expect(entries).toEqual(['mcp-chemistry'])
  })
})
