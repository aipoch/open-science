import { describe, it, expect } from 'vitest'
import { renderSkillDoc, renderCustomSkillDoc } from './skill-doc'

describe('renderSkillDoc', () => {
  it('renders frontmatter, conventions, and each tool', () => {
    const md = renderSkillDoc('chemistry')
    expect(md).toContain('name: mcp-chemistry')
    expect(md).toContain('source: connector')
    expect(md).toContain('host.mcp(')
    expect(md).toContain('pubchem_get_compounds')
    expect(md).toContain('rate-limited') // rate warning present
  })
  it('uses the trigger-style useWhen as the frontmatter description for auto-discovery', () => {
    const md = renderSkillDoc('chemistry')
    // The frontmatter description is what Claude Code matches a plain user question against.
    const frontmatter = md.slice(0, md.indexOf('---', 3))
    expect(frontmatter).toMatch(/description: ".*Use when.*"/)
    expect(md).toContain('## When to Use')
  })
  it('throws for an unknown connector', () => {
    expect(() => renderSkillDoc('nope')).toThrow()
  })
  it('renders a tool-authored example as a single realistic call, with no per-tool prose', () => {
    // The example carries only realistic args (better than schema placeholders). General guidance
    // (reuse across cells, return shape) lives once in the shared conventions template — it must NOT
    // be duplicated into each tool's example.
    const md = renderSkillDoc('pubmed')
    const block = md.slice(
      md.indexOf('### search_articles'),
      md.indexOf('### get_article_metadata')
    )
    const code = block
      .slice(block.indexOf('```js\n') + '```js\n'.length, block.lastIndexOf('```'))
      .trim()
    expect(code).toBe(
      'const result = await host.mcp("pubmed", "search_articles", {"query": "CRISPR gene editing", "max_results": 10})'
    )
    expect(code).not.toContain('#') // no per-tool comment/prose
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
      { name: 'acme', description: 'Use when you need acme tools.' },
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
    const md = renderCustomSkillDoc({ name: 'acme' }, [
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
  it('gives custom MCP servers the same reuse guidance', () => {
    // renderCustomSkillDoc shares the CONVENTIONS block, so the fix must reach custom servers too.
    const md = renderCustomSkillDoc(
      { name: 'acme', description: 'Use when you need acme tools.' },
      [{ name: 'do_thing', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }]
    )
    expect(md).toContain('persistent')
    expect(md).toMatch(/instead of running the call again/)
  })
})
