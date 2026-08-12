import { describe, it, expect } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderCustomSkillDoc } from './skill-doc'
import {
  syncConnectorSkillDocs,
  syncCustomServerSkillDocs,
  syncMaterializedCustomServerSkillDocs
} from './provision'
import type { StoredCustomMcpServer } from '../settings/types'

const FAKE_TOOLS = [
  { name: 'search', description: 'Search the corpus', inputSchema: { type: 'object' } },
  { name: 'fetch', description: 'Fetch one record' }
]

function makeServer(overrides: Partial<StoredCustomMcpServer> = {}): StoredCustomMcpServer {
  return {
    id: 'srv-1',
    name: 'myserver',
    displayName: 'My server',
    transport: 'stdio',
    command: 'npx',
    enabled: true,
    ...overrides
  }
}

describe('renderCustomSkillDoc', () => {
  it('uses the immutable name for skill identity and routing while keeping displayName in prose', () => {
    const md = renderCustomSkillDoc(
      { name: 'example-oauth-e2e', displayName: 'Example OAuth E2E' },
      FAKE_TOOLS
    )
    expect(md).toContain('name: mcp-example-oauth-e2e')
    expect(md).toContain('Example OAuth E2E MCP server')
    expect(md).toContain('source: connector')
    expect(md).toMatch(/description: ".*Use when.*"/)
    expect(md.match(/Use when/g)).toHaveLength(1)
    expect(md).toContain('search')
    expect(md).toContain('fetch')
    expect(md).toContain('"type":"object"')
    // No-arg tools render without a third argument (a literal ... would reach the bridge as Ellipsis).
    expect(md).toContain('host.mcp("example-oauth-e2e", "search")')
    expect(md).toContain('host.mcp("example-oauth-e2e", "fetch")')
  })

  it('changes generated prose without changing Skill or host.mcp identity', () => {
    const before = renderCustomSkillDoc(
      { name: 'stable-connector', displayName: 'Before Label' },
      FAKE_TOOLS
    )
    const after = renderCustomSkillDoc(
      { name: 'stable-connector', displayName: 'After Label' },
      FAKE_TOOLS
    )

    expect(before).toContain('Before Label MCP server')
    expect(after).toContain('After Label MCP server')
    for (const doc of [before, after]) {
      expect(doc).toContain('name: mcp-stable-connector')
      expect(doc).toContain('host.mcp("stable-connector", "search")')
    }
  })

  it('uses the server-provided description verbatim when present', () => {
    const md = renderCustomSkillDoc(
      {
        name: 'myserver',
        displayName: 'My server',
        description: 'Use when the user asks about widgets.'
      },
      FAKE_TOOLS
    )
    const frontmatter = md.slice(0, md.indexOf('---', 3))
    expect(frontmatter).toContain('Use when the user asks about widgets.')
  })

  it('renders a concrete dict example from a custom tool inputSchema', () => {
    const md = renderCustomSkillDoc({ name: 'myserver', displayName: 'My server' }, [
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

  it('refreshes one server without validating or deleting unrelated server Skills', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'custom-skills-targeted-'))
    const target = makeServer({ id: 'target', name: 'target', displayName: 'Target' })
    const unrelated = makeServer({
      id: 'unrelated',
      name: 'unrelated',
      displayName: 'Unrelated'
    })
    const listTools = async (): Promise<typeof FAKE_TOOLS> => FAKE_TOOLS

    await syncCustomServerSkillDocs(dir, [target, unrelated], listTools)
    await syncCustomServerSkillDocs(dir, [target], listTools, ['target'])

    expect((await readdir(dir)).sort()).toEqual(['mcp-target', 'mcp-unrelated'])
  })

  it('isolates an unavailable server while materializing the remaining enabled servers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'custom-skills-unavailable-'))
    const unavailable = makeServer({ id: 'unavailable', name: 'unavailable' })
    const healthy = makeServer({ id: 'healthy', name: 'healthy', displayName: 'Healthy server' })
    await mkdir(join(dir, 'mcp-unavailable'), { recursive: true })
    await writeFile(join(dir, 'mcp-unavailable', 'SKILL.md'), 'stale')

    const result = await syncCustomServerSkillDocs(dir, [unavailable, healthy], async (server) => {
      if (server.id === unavailable.id) {
        throw new Error('MCP error -32000: Connection closed')
      }
      return FAKE_TOOLS
    })

    expect(result.materializedNames).toEqual(['healthy'])
    expect(result.failures).toEqual([
      {
        server: unavailable,
        error: expect.objectContaining({ message: 'MCP error -32000: Connection closed' })
      }
    ])
    expect((await readdir(dir)).sort()).toEqual(['mcp-healthy'])
  })

  it('never lets a malicious server name escape the skills dir or clobber a bundled connector', async () => {
    const root = await mkdtemp(join(tmpdir(), 'custom-skills-safe-'))
    const dir = join(root, 'skills')
    const listTools = async (): Promise<typeof FAKE_TOOLS> => FAKE_TOOLS

    // Display names never become paths. Explicit safe names remain the only directory identities.
    const traversal = makeServer({ name: 'safe-escape', displayName: '../escape' })
    const collision = makeServer({ name: 'custom-chemistry', displayName: 'chemistry' })

    await syncCustomServerSkillDocs(dir, [traversal, collision], listTools)

    // Nothing was written outside the skills dir.
    expect((await readdir(root)).sort()).toEqual(['skills'])
    // Both servers materialized under their name, and no `mcp-chemistry` directory was produced.
    const entries = (await readdir(dir)).sort()
    expect(entries).toEqual(['mcp-custom-chemistry', 'mcp-safe-escape'])
  })

  it('skips an unsafe name and a built-in collision', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'custom-skills-tampered-'))
    const listTools = async (): Promise<typeof FAKE_TOOLS> => FAKE_TOOLS

    const badPath = makeServer({ name: '../../evil', displayName: 'Evil server' })
    const bundledId = makeServer({ name: 'chemistry', displayName: 'Other server' })

    await syncCustomServerSkillDocs(dir, [badPath, bundledId], listTools)

    expect((await readdir(dir)).sort()).toEqual([])
  })

  it('does not overwrite a built-in connector with a case-variant name', async () => {
    // On a case-insensitive filesystem `mcp-Chemistry` and `mcp-chemistry` are the same directory, so
    // a tampered mixed-case name must be rejected.
    const dir = await mkdtemp(join(tmpdir(), 'connector-case-'))
    await syncConnectorSkillDocs(dir, ['chemistry'])
    const builtinDoc = join(dir, 'mcp-chemistry', 'SKILL.md')
    const before = await readFile(builtinDoc, 'utf8')

    const tampered = makeServer({ name: 'Chemistry', displayName: 'Tampered' })
    await syncCustomServerSkillDocs(dir, [tampered], async () => [])

    // The built-in doc is untouched, and no case-variant directory was created.
    expect(await readFile(builtinDoc, 'utf8')).toBe(before)
    expect((await readdir(dir)).sort()).toEqual(['mcp-chemistry'])
  })

  it('does not delete the built-in doc when an upgrade left a case-variant directory', async () => {
    // Real upgrade state: an OLD version wrote mcp-Chemistry (from a custom server named "Chemistry").
    // On a case-preserving filesystem the built-in sync then writes chemistry's doc into that same
    // directory; the custom cleanup must recognize it as bundled-owned (case-insensitively) and keep it.
    const dir = await mkdtemp(join(tmpdir(), 'connector-upgrade-'))
    await mkdir(join(dir, 'mcp-Chemistry'), { recursive: true })
    await writeFile(join(dir, 'mcp-Chemistry', 'SKILL.md'), 'stale pre-upgrade content')

    await syncConnectorSkillDocs(dir, ['chemistry'])
    await syncCustomServerSkillDocs(dir, [], async () => [])

    // The built-in chemistry doc survived (readable case-insensitively) and holds the built-in content.
    const doc = await readFile(join(dir, 'mcp-chemistry', 'SKILL.md'), 'utf8')
    expect(doc).toContain('source: connector')
    expect(doc).toContain('name: mcp-chemistry')

    // Exactly one case-fold-equivalent directory remains: on a case-sensitive filesystem the stale
    // mcp-Chemistry variant is removed, on a case-insensitive one it never duplicated.
    const entries = await readdir(dir)
    const folded = entries.map((entry) => entry.toLowerCase())
    expect(new Set(folded).size).toBe(entries.length)
    expect(folded).toEqual(['mcp-chemistry'])
  })

  it('fails closed without overwriting an unowned case-variant custom directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'custom-skill-case-conflict-'))
    await mkdir(join(dir, 'mcp-XT'), { recursive: true })
    await writeFile(join(dir, 'mcp-XT', 'SKILL.md'), 'unowned uppercase content')

    const result = await syncCustomServerSkillDocs(
      dir,
      [makeServer({ name: 'xt', displayName: 'XT' })],
      async () => FAKE_TOOLS
    )

    expect(result.materializedNames).toEqual([])
    expect(result.failures).toHaveLength(1)
    const entries = await readdir(dir)
    expect(entries).toEqual(['mcp-XT'])
    expect(await readFile(join(dir, entries[0], 'SKILL.md'), 'utf8')).toBe(
      'unowned uppercase content'
    )
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

describe('syncMaterializedCustomServerSkillDocs', () => {
  it('copies only valid projected docs and cleans stale custom docs without touching other owners', async () => {
    const root = await mkdtemp(join(tmpdir(), 'custom-skill-copy-'))
    const source = join(root, 'source')
    const target = join(root, 'target')
    await Promise.all([
      mkdir(join(source, 'mcp-xt'), { recursive: true }),
      mkdir(join(source, 'mcp-malformed'), { recursive: true }),
      mkdir(join(target, 'mcp-stale'), { recursive: true }),
      mkdir(join(target, 'mcp-pubmed'), { recursive: true }),
      mkdir(join(target, 'mcp-MySkill'), { recursive: true }),
      mkdir(join(target, 'mcp-custom.v2'), { recursive: true }),
      mkdir(join(target, 'user-skill'), { recursive: true })
    ])
    const xtDoc =
      '---\nname: mcp-xt\ndescription: Use XT records.\nsource: connector\n---\n\n# XT\n'
    await Promise.all([
      writeFile(join(source, 'mcp-xt', 'SKILL.md'), xtDoc),
      writeFile(join(source, 'mcp-malformed', 'SKILL.md'), '# missing frontmatter'),
      writeFile(join(target, 'mcp-stale', 'SKILL.md'), 'stale'),
      writeFile(join(target, 'mcp-pubmed', 'SKILL.md'), 'bundled'),
      writeFile(join(target, 'mcp-MySkill', 'SKILL.md'), 'user uppercase'),
      writeFile(join(target, 'mcp-custom.v2', 'SKILL.md'), 'user punctuation'),
      writeFile(join(target, 'user-skill', 'SKILL.md'), 'user')
    ])

    const result = await syncMaterializedCustomServerSkillDocs(source, target, [
      'mcp-xt',
      'mcp-xt',
      'mcp-malformed',
      'mcp-missing',
      'mcp-pubmed',
      'mcp-../../escape'
    ])

    expect(result.materializedSkillNames).toEqual(['mcp-xt'])
    expect(result.failures.map(({ skillName }) => skillName)).toEqual([
      'mcp-malformed',
      'mcp-missing'
    ])
    expect((await readdir(target)).sort()).toEqual([
      'mcp-MySkill',
      'mcp-custom.v2',
      'mcp-pubmed',
      'mcp-xt',
      'user-skill'
    ])
    expect(await readFile(join(target, 'mcp-xt', 'SKILL.md'), 'utf8')).toBe(xtDoc)
    expect(await readFile(join(target, 'mcp-pubmed', 'SKILL.md'), 'utf8')).toBe('bundled')
  })

  it('fails closed without overwriting an unowned case-variant target directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'custom-skill-copy-case-'))
    const source = join(root, 'source')
    const target = join(root, 'target')
    await Promise.all([
      mkdir(join(source, 'mcp-xt'), { recursive: true }),
      mkdir(join(target, 'mcp-XT'), { recursive: true })
    ])
    const xtDoc =
      '---\nname: mcp-xt\ndescription: Use XT records.\nsource: connector\n---\n\n# XT\n'
    await Promise.all([
      writeFile(join(source, 'mcp-xt', 'SKILL.md'), xtDoc),
      writeFile(join(target, 'mcp-XT', 'SKILL.md'), 'stale')
    ])

    const result = await syncMaterializedCustomServerSkillDocs(source, target, ['mcp-xt'])

    expect(result.materializedSkillNames).toEqual([])
    expect(result.failures.map(({ skillName }) => skillName)).toEqual(['mcp-xt'])
    const entries = await readdir(target)
    expect(entries).toEqual(['mcp-XT'])
    expect(await readFile(join(target, entries[0], 'SKILL.md'), 'utf8')).toBe('stale')
  })
})
