import { describe, it, expect } from 'vitest'
import { Tiktoken } from 'js-tiktoken/lite'
import cl100kBase from 'js-tiktoken/ranks/cl100k_base'
import { renderConnectorInstructions, renderSkillDoc, renderCustomSkillDoc } from './skill-doc'
import { CONNECTOR_CATALOG } from './catalog'

const tokenizer = new Tiktoken(cl100kBase)

describe('renderConnectorInstructions', () => {
  it('keeps only shared host.mcp conventions in opencode baseline instructions', () => {
    const md = renderConnectorInstructions(['mcp-chemistry'])

    expect(md).toContain('host.mcp(')
    // The "do not reimplement with raw HTTP" rule is what steers opencode away from raw requests.
    expect(md).toMatch(/urllib|requests|httpx|fetch/)
    expect(md).toContain('mcp-*')
    expect(md).toContain('process.env.OPEN_SCIENCE_HANDOFF_DIR')
    expect(md).not.toContain('./handoff/')
    expect(md).not.toContain('## chemistry')
    expect(md).not.toContain('pubchem_get_compounds')
    expect(md).not.toContain('```json')
    expect(md.length).toBeLessThan(2_500)
    // Conventions appear once, not per connector.
    expect(
      md.match(/Reach this service ONLY from the REPL control-plane kernel/g)?.length ?? 0
    ).toBe(1)
  })

  it('returns empty string when no connectors are enabled', () => {
    expect(renderConnectorInstructions([])).toBe('')
    expect(renderConnectorInstructions(['nope'])).toBe('')
  })

  it('forbids connector calls until the matching skill supplies the exact method name', () => {
    const md = renderConnectorInstructions(['mcp-pubmed'])

    expect(md).toContain('Load the matching `mcp-*` skill before the first `host.mcp` call')
    expect(md).toContain('Never guess a connector server or method name')
  })

  it('lists the exact enabled Connector Skill names without duplicates or guessed aliases', () => {
    const md = renderConnectorInstructions([
      'mcp-pubmed',
      'mcp-literature',
      'mcp-pubmed',
      'not-a-skill'
    ])

    expect(md).toContain('Globally Enabled Connector Skills: `mcp-pubmed`, `mcp-literature`.')
    expect(md).toContain('`<open_science_specialist_skill_scope>` block')
    expect(md).toContain('do not load or call any `mcp-*` skill absent from that block')
    expect(md.match(/`mcp-pubmed`/g)).toHaveLength(1)
    expect(md).not.toContain('`mcp-openalex`')
  })

  it('includes canonical custom MCP Skill names in the global catalog', () => {
    const md = renderConnectorInstructions(['mcp-pubmed', 'mcp-custom-chemistry'])

    expect(md).toContain('Globally Enabled Connector Skills: `mcp-pubmed`, `mcp-custom-chemistry`.')
  })
})

describe('renderSkillDoc', () => {
  it('renders a compact self-contained catalog without repeating the shared conventions', () => {
    const md = renderSkillDoc('chemistry')
    expect(md).toContain('name: mcp-chemistry')
    expect(md).toContain('source: connector')
    expect(md).toContain('host.mcp(')
    expect(md).toContain('pubchem_get_compounds')
    expect(md).toContain('rate-limited') // rate warning present
    expect(md).not.toContain('Do NOT reimplement these calls with raw HTTP')
  })
  it('uses the trigger-style useWhen as the frontmatter description for auto-discovery', () => {
    const md = renderSkillDoc('chemistry')
    // The frontmatter description is what Claude Code matches a plain user question against.
    const frontmatter = md.slice(0, md.indexOf('---', 3))
    expect(frontmatter).toMatch(/description: ".*Use when.*"/)
    expect(md.match(/Use when/g)).toHaveLength(1)
  })
  it('throws for an unknown connector', () => {
    expect(() => renderSkillDoc('nope')).toThrow()
  })
  it('renders a tool-authored example as a single compact realistic call', () => {
    // The example carries only realistic args (better than schema placeholders). General guidance
    // (reuse across cells, return shape) lives once in the shared conventions template — it must NOT
    // be duplicated into each tool's example.
    const md = renderSkillDoc('pubmed')
    const block = md.slice(
      md.indexOf('### search_articles'),
      md.indexOf('### get_article_metadata')
    )
    expect(block).toContain(
      'const result = await host.mcp("pubmed", "search_articles", {"query": "CRISPR gene editing", "max_results": 10})'
    )
    expect(block).not.toContain('```')
  })
  it('does not hardcode a processing/display method in the doc', () => {
    // Requirement: the skill doc states facts (shape lives in Returns, result is a Python value) but
    // never prescribes how to handle it — so no `print(...)` or `json.dumps(...)` recipes.
    const md = renderSkillDoc('pubmed')
    expect(md).not.toContain('print(')
    expect(md).not.toContain('json.dumps')
    expect(md).not.toContain('json.loads')
  })
  it('falls back to a schema-built call example for tools without an authored example', () => {
    // Custom MCP servers ship no `example`, so the doc must still render a concrete, copyable call.
    const md = renderCustomSkillDoc(
      { name: 'acme', displayName: 'Acme', description: 'Use when you need acme tools.' },
      [
        {
          name: 'do_thing',
          inputSchema: {
            type: 'object',
            properties: { q: { type: 'string' } },
            required: ['q']
          }
        }
      ]
    )
    expect(md).toContain('const result = await host.mcp("acme", "do_thing", {"q": "..."})')
  })
  it('renders a no-arg tool without a third argument (never a literal ...)', () => {
    // A literal `...` as the args positional reaches the bridge as Ellipsis and raises; a no-arg tool
    // must render as host.mcp(server, method) so the example is copy-runnable.
    const md = renderCustomSkillDoc({ name: 'acme', displayName: 'Acme' }, [
      { name: 'ping', inputSchema: { type: 'object', properties: {} } }
    ])
    expect(md).toContain('const result = await host.mcp("acme", "ping")')
    expect(md).not.toContain('"ping", ...)') // never a literal Ellipsis as the args positional
  })
  it('frames the calling convention positively (await the repl host.mcp call)', () => {
    const md = renderSkillDoc('pubmed')
    expect(md).toContain('const result = await host.mcp(server, method, {...})')
  })
  it('documents the return shape so agents need not probe it', () => {
    const md = renderSkillDoc('pubmed')
    expect(md).toContain('**Returns:**')
    // A return-shape field absent from the input schema — proves the Returns block is rendered.
    expect(md).toContain('"pmid"')
  })
  it('tells the agent the kernel persists so it reuses the result instead of re-calling', () => {
    // Root cause of the observed double host.mcp call: the doc never said the kernel is a
    // persistent shared session, so the agent re-issued the (rate-limited) call in a second cell
    // instead of reusing the variable it had already assigned.
    const md = renderSkillDoc('pubmed')
    expect(md).toContain('persistent')
    expect(md).toContain('native JavaScript')
    expect(md).toMatch(/instead of running the call again/)
    expect(md).toMatch(/never re-(issue|call)/i)
  })
  it('keeps planned connector work in fewer model round trips and bounds returned context', () => {
    const baseline = renderConnectorInstructions(['mcp-pubmed'])
    const skill = renderSkillDoc('pubmed')

    for (const md of [baseline, skill]) {
      expect(md).toMatch(/independent.*same `repl_execute`/i)
      expect(md).toMatch(/keep large results.*globalThis/i)
      expect(md).toMatch(/compact summary/i)
    }
  })
  it('gives custom MCP servers the same reuse guidance', () => {
    // Custom servers do not always receive the bundled connector baseline, so their compact Skill
    // still carries the minimum persistence rule without copying the full shared conventions.
    const md = renderCustomSkillDoc(
      { name: 'acme', displayName: 'Acme', description: 'Use when you need acme tools.' },
      [{ name: 'do_thing', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }]
    )
    expect(md).toContain('persistent')
    expect(md).toMatch(/instead of running the call again/)
    expect(md).toContain('Do not bypass `host.mcp` with raw HTTP')
    expect(md).toContain('approval')
    expect(md).toMatch(/independent.*same `repl_execute`/i)
    expect(md).toMatch(/keep large results.*globalThis/i)
    expect(md).toMatch(/compact summary/i)
  })

  it('directs custom connector authentication failures to a listed login tool', () => {
    const md = renderCustomSkillDoc({ name: 'content-service', displayName: 'Content Service' }, [
      { name: 'content_login' },
      { name: 'search' }
    ])

    expect(md).toContain('`connector_unauthenticated`')
    expect(md).toContain('use a login or authentication tool listed in this Skill')
    expect(md).toContain('then retry the original call')
    expect(md).toContain('Do not treat an authentication requirement as connector unavailability')
    expect(md).not.toContain('Settings > Connectors')
  })

  it('directs host-managed OAuth authentication to Connector settings', () => {
    const md = renderCustomSkillDoc(
      { name: 'content-service', displayName: 'Content Service', oauth: {} },
      [{ name: 'content_login' }, { name: 'search' }]
    )

    expect(md).toContain('`connector_unauthenticated`')
    expect(md).toContain('Settings > Connectors')
    expect(md).toContain('then retry the original call')
    expect(md).not.toContain('use a login or authentication tool listed in this Skill')
  })

  it('omits authentication recovery guidance when the connector declares neither mode', () => {
    const md = renderCustomSkillDoc({ name: 'content-service', displayName: 'Content Service' }, [
      { name: 'search' }
    ])

    expect(md).not.toContain('`connector_unauthenticated`')
    expect(md).not.toContain('Settings > Connectors')
  })

  it('keeps the PubMed Skill under a 2.3k-token on-demand budget', () => {
    const md = renderSkillDoc('pubmed')

    expect(tokenizer.encode(md).length).toBeLessThan(2_300)
  })

  it('keeps every authored connector example valid for the JavaScript REPL', () => {
    for (const connector of CONNECTOR_CATALOG) {
      const md = renderSkillDoc(connector.id)
      expect(md, connector.id).not.toMatch(/host\.mcp\([^\n]*\b(?:True|False|None)\b/)
    }
  })
})
