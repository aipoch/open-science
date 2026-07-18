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
  it('renders frontmatter keyed on the server id, a composed "Use when" description, and each tool', () => {
    const md = renderCustomSkillDoc({ id: 'srv-1', name: 'myserver' }, FAKE_TOOLS)
    // The skill name is the immutable id, not the user-facing display name.
    expect(md).toContain('name: mcp-srv-1')
    expect(md).not.toContain('name: mcp-myserver')
    expect(md).toContain('source: connector')
    expect(md).toMatch(/description: ".*Use when.*"/)
    expect(md).toContain('## When to Use')
    expect(md).toContain('search')
    expect(md).toContain('fetch')
    expect(md).toContain('"type": "object"')
    // Runtime routing still uses the display name (the key McpClientManager registers under).
    // No-arg tools render without a third argument (a literal ... would reach the bridge as Ellipsis).
    expect(md).toContain('host.mcp("myserver", "search")')
    expect(md).toContain('host.mcp("myserver", "fetch")')
  })

  it('uses the server-provided description verbatim when present', () => {
    const md = renderCustomSkillDoc(
      { id: 'srv-1', name: 'myserver', description: 'Use when the user asks about widgets.' },
      FAKE_TOOLS
    )
    const frontmatter = md.slice(0, md.indexOf('---', 3))
    expect(frontmatter).toContain('Use when the user asks about widgets.')
  })

  it('renders a concrete dict example from a custom tool inputSchema', () => {
    const md = renderCustomSkillDoc({ id: 'srv-1', name: 'myserver' }, [
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
    expect(md).toContain('result = host.mcp("myserver", "lookup", {"id": "...", "limit": 10})')
  })
})

describe('syncCustomServerSkillDocs', () => {
  it('writes mcp-<id>/SKILL.md for an enabled server and removes it once disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'custom-skills-'))
    const server = makeServer()
    const listTools = async (): Promise<typeof FAKE_TOOLS> => FAKE_TOOLS

    await syncCustomServerSkillDocs(dir, [server], listTools)

    let entries = (await readdir(dir)).sort()
    expect(entries).toEqual(['mcp-srv-1'])
    expect((await stat(join(dir, 'mcp-srv-1'))).isDirectory()).toBe(true)
    const doc = await readFile(join(dir, 'mcp-srv-1', 'SKILL.md'), 'utf8')
    expect(doc).toContain('name: mcp-srv-1')

    // Server no longer enabled -> its skill dir is removed.
    await syncCustomServerSkillDocs(dir, [], listTools)
    entries = (await readdir(dir)).sort()
    expect(entries).toEqual([])
  })

  it('never lets a malicious server name escape the skills dir or clobber a bundled connector', async () => {
    const root = await mkdtemp(join(tmpdir(), 'custom-skills-safe-'))
    const dir = join(root, 'skills')
    const listTools = async (): Promise<typeof FAKE_TOOLS> => FAKE_TOOLS

    // A name with path separators and one equal to a bundled connector id: both must be neutralized
    // because the directory is keyed on the immutable UUID id, not the name.
    const traversal = makeServer({ id: 'srv-escape', name: '../escape' })
    const collision = makeServer({ id: 'srv-chem', name: 'chemistry' })

    await syncCustomServerSkillDocs(dir, [traversal, collision], listTools)

    // Nothing was written outside the skills dir.
    expect((await readdir(root)).sort()).toEqual(['skills'])
    // Both servers materialized under their id, and no `mcp-chemistry` directory was produced.
    const entries = (await readdir(dir)).sort()
    expect(entries).toEqual(['mcp-srv-chem', 'mcp-srv-escape'])
  })

  it('skips a server whose id is not a safe path segment (tampered settings)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'custom-skills-tampered-'))
    const listTools = async (): Promise<typeof FAKE_TOOLS> => FAKE_TOOLS

    // A hand-crafted id with separators or equal to a bundled id must be dropped entirely.
    const badPath = makeServer({ id: '../../evil', name: 'evil' })
    const bundledId = makeServer({ id: 'chemistry', name: 'evil2' })

    await syncCustomServerSkillDocs(dir, [badPath, bundledId], listTools)

    expect((await readdir(dir)).sort()).toEqual([])
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
    expect(entries).toEqual(['mcp-chemistry', 'mcp-srv-1'])

    // Re-running the bundled sync must not remove the custom server's directory...
    await syncConnectorSkillDocs(dir, ['chemistry'])
    entries = (await readdir(dir)).sort()
    expect(entries).toEqual(['mcp-chemistry', 'mcp-srv-1'])

    // ...and re-running the custom sync must not remove the bundled connector's directory.
    await syncCustomServerSkillDocs(dir, [server], listTools)
    entries = (await readdir(dir)).sort()
    expect(entries).toEqual(['mcp-chemistry', 'mcp-srv-1'])

    // Disabling the bundled connector only removes the bundled dir, leaving the custom one intact.
    await syncConnectorSkillDocs(dir, [])
    entries = (await readdir(dir)).sort()
    expect(entries).toEqual(['mcp-srv-1'])

    // And disabling the custom server only removes the custom dir.
    await syncConnectorSkillDocs(dir, ['chemistry'])
    await syncCustomServerSkillDocs(dir, [], listTools)
    entries = (await readdir(dir)).sort()
    expect(entries).toEqual(['mcp-chemistry'])
  })
})
