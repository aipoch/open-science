import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'

import {
  LOAD_SKILL_TOOL_NAME,
  SKILL_RUNTIME_ALLOWED_NAMES_ENV,
  SKILL_RUNTIME_ROOT_ENV,
  createSkillRuntimeMcpServer,
  environmentFromProcess,
  loadSkillDocument
} from './runtime-mcp-server'

const roots: string[] = []

const seedProjection = async (name = 'fixture-review'): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'open-science-skill-runtime-'))
  roots.push(root)
  const skillDir = join(root, '.claude', 'skills', name)
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Synthetic review fixture.\n---\n\n# Synthetic review fixture\n`
  )
  return root
}

const seedSkill = async (
  root: string,
  name: string,
  description: string,
  extraFrontmatter = ''
): Promise<void> => {
  const skillDir = join(root, '.claude', 'skills', name)
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n${extraFrontmatter}---\n\n# ${name}\n`
  )
}

const listRuntimeTools = async (
  root: string,
  allowedNames?: ReadonlySet<string>
): Promise<Awaited<ReturnType<Client['listTools']>>> => {
  const server = await createSkillRuntimeMcpServer({ root, allowedNames })
  const client = new Client({ name: 'skill-runtime-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    return await client.listTools()
  } finally {
    await client.close()
    await server.close()
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Claude Skill runtime MCP loader', () => {
  it('advertises projected Skills to Claude without application metadata', async () => {
    const root = await seedProjection('fixture-data-summary')
    await seedSkill(root, 'fixture-diagram-renderer', 'Render synthetic diagrams for tests.')

    const tools = await listRuntimeTools(root)
    const loader = tools.tools.find((tool) => tool.name === LOAD_SKILL_TOOL_NAME)
    const inputSchema = JSON.stringify(loader?.inputSchema)

    expect(inputSchema).toContain('fixture-data-summary')
    expect(inputSchema).toContain('Synthetic review fixture.')
    expect(inputSchema).toContain('fixture-diagram-renderer')
    expect(inputSchema).toContain('Render synthetic diagrams for tests.')
    expect(inputSchema).not.toContain(root)
    expect(inputSchema).not.toContain('open-science')
    expect(inputSchema).not.toContain('os-')
    expect(inputSchema).not.toContain('imported')
    expect(inputSchema).not.toContain('personal')
  })

  it('keeps the complete discovery catalog in the input schema instead of the truncated tool description', async () => {
    const root = await seedProjection('catalog-skill-000')
    await Promise.all(
      Array.from({ length: 39 }, (_, index) =>
        seedSkill(
          root,
          `catalog-skill-${String(index + 1).padStart(3, '0')}`,
          `Selection metadata ${index + 1} ${'x'.repeat(80)}`
        )
      )
    )

    const tools = await listRuntimeTools(root)
    const loader = tools.tools.find((tool) => tool.name === LOAD_SKILL_TOOL_NAME)
    const inputSchema = JSON.stringify(loader?.inputSchema)

    expect(loader?.description?.length).toBeLessThan(2_048)
    expect(loader?.description).not.toContain('catalog-skill-000')
    expect(loader?.description).not.toContain('catalog-skill-039')
    expect(inputSchema).toContain('catalog-skill-000')
    expect(inputSchema).toContain('Synthetic review fixture.')
    expect(inputSchema).toContain('catalog-skill-039')
    expect(inputSchema).toContain('Selection metadata 39')
  })

  it('discovers a valid Skill whose frontmatter extends beyond one read chunk', async () => {
    const root = await seedProjection('base-skill')
    const name = 'long-frontmatter'
    const skillDir = join(root, '.claude', 'skills', name)
    await mkdir(skillDir)
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---\nname: ${name}\n${'# catalog metadata padding\n'.repeat(3_000)}description: Long frontmatter remains discoverable.\n---\n\n# Long\n`
    )

    const tools = await listRuntimeTools(root)
    const inputSchema = JSON.stringify(
      tools.tools.find((tool) => tool.name === LOAD_SKILL_TOOL_NAME)?.inputSchema
    )

    expect(inputSchema).toContain('long-frontmatter')
    expect(inputSchema).toContain('Long frontmatter remains discoverable.')
  })

  it('advertises only the exact Specialist Skill scope', async () => {
    const root = await seedProjection('fixture-review')
    await seedSkill(root, 'fixture-data-summary', 'Summarize synthetic tabular test data.')

    const tools = await listRuntimeTools(root, new Set(['fixture-data-summary']))
    const inputSchema = JSON.stringify(
      tools.tools.find((tool) => tool.name === LOAD_SKILL_TOOL_NAME)?.inputSchema
    )

    expect(inputSchema).toContain('fixture-data-summary')
    expect(inputSchema).toContain('Summarize synthetic tabular test data.')
    expect(inputSchema).not.toContain('fixture-review')
    expect(inputSchema).not.toContain('Synthetic review fixture.')
  })

  it('does not advertise model-disabled or invalid projected packages', async () => {
    const root = await seedProjection('visible-skill')
    await seedSkill(
      root,
      'explicit-only',
      'Use only through an explicit invocation.',
      'disable-model-invocation: true\n'
    )
    const mismatchedDir = join(root, '.claude', 'skills', 'mismatched-skill')
    await mkdir(mismatchedDir)
    await writeFile(
      join(mismatchedDir, 'SKILL.md'),
      '---\nname: another-name\ndescription: Must stay hidden.\n---\n'
    )
    const outside = await mkdtemp(join(tmpdir(), 'open-science-skill-runtime-catalog-outside-'))
    roots.push(outside)
    await writeFile(
      join(outside, 'SKILL.md'),
      '---\nname: linked-skill\ndescription: Must stay hidden too.\n---\n'
    )
    await symlink(outside, join(root, '.claude', 'skills', 'linked-skill'))

    const tools = await listRuntimeTools(root)
    const inputSchema = JSON.stringify(
      tools.tools.find((tool) => tool.name === LOAD_SKILL_TOOL_NAME)?.inputSchema
    )

    expect(inputSchema).toContain('visible-skill')
    expect(inputSchema).not.toContain('explicit-only')
    expect(inputSchema).not.toContain('mismatched-skill')
    expect(inputSchema).not.toContain('another-name')
    expect(inputSchema).not.toContain('linked-skill')
    expect(inputSchema).not.toContain('Must stay hidden')
  })

  it('bounds discovery metadata while keeping omitted Skills explicitly invocable', async () => {
    const root = await seedProjection('base-skill')
    await Promise.all(
      Array.from({ length: 260 }, (_, index) =>
        seedSkill(
          root,
          `catalog-skill-${String(index).padStart(3, '0')}`,
          `Catalog entry ${index}.`
        )
      )
    )

    const tools = await listRuntimeTools(root)
    const loader = tools.tools.find((tool) => tool.name === LOAD_SKILL_TOOL_NAME)
    const inputSchema = JSON.stringify(loader?.inputSchema)

    expect(Buffer.byteLength(loader?.description ?? '', 'utf8')).toBeLessThan(2_048)
    expect(Buffer.byteLength(inputSchema, 'utf8')).toBeLessThanOrEqual(64 * 1024)
    expect(inputSchema).toContain('omitted from discovery metadata')
    expect(inputSchema).not.toContain('catalog-skill-259')
    await expect(loadSkillDocument({ root }, 'catalog-skill-259')).resolves.toContain(
      '# catalog-skill-259'
    )
  })

  it('loads a canonical Skill with its readable projected base directory', async () => {
    const root = await seedProjection()

    await expect(loadSkillDocument({ root }, 'fixture-review')).resolves.toBe(
      `Base directory for this skill: ${join(root, '.claude', 'skills', 'fixture-review')}\n\n` +
        '---\nname: fixture-review\ndescription: Synthetic review fixture.\n---\n\n# Synthetic review fixture\n'
    )
  })

  it('enforces an exact Specialist allowlist', async () => {
    const root = await seedProjection()

    await expect(
      loadSkillDocument({ root, allowedNames: new Set(['different-skill']) }, 'fixture-review')
    ).rejects.toThrow('Unknown skill: fixture-review')
  })

  it('applies native Skill argument placeholders without executing them', async () => {
    const root = await seedProjection('argument-skill')
    const documentPath = join(root, '.claude', 'skills', 'argument-skill', 'SKILL.md')
    await writeFile(
      documentPath,
      [
        '---',
        'name: argument-skill',
        'description: Arguments.',
        'arguments: [target, format]',
        '---',
        '',
        'all=$ARGUMENTS indexed=$ARGUMENTS[0] first=$0 second=$1',
        'named=$target/$format dir=${CLAUDE_SKILL_DIR}'
      ].join('\n')
    )

    const loaded = await loadSkillDocument({ root }, 'argument-skill', 'hello "two words"')

    expect(loaded).toContain(
      `all=hello "two words" indexed=hello first=hello second=two words\n` +
        `named=hello/two words dir=${join(root, '.claude', 'skills', 'argument-skill')}`
    )
    expect(loaded).not.toContain('\n\nARGUMENTS:')
  })

  it('appends arguments when a Skill document has no argument placeholder', async () => {
    const root = await seedProjection('plain-skill')

    await expect(loadSkillDocument({ root }, 'plain-skill', 'requested target')).resolves.toMatch(
      /# Synthetic review fixture\n\nARGUMENTS: requested target$/
    )
  })

  it('rejects traversal and symbolic-link packages', async () => {
    const root = await seedProjection()
    await expect(loadSkillDocument({ root }, '../fixture-review')).rejects.toThrow('Unknown skill')

    const outside = await mkdtemp(join(tmpdir(), 'open-science-skill-runtime-outside-'))
    roots.push(outside)
    await writeFile(join(outside, 'SKILL.md'), 'outside')
    const linkedName = 'linked-skill'
    await symlink(outside, join(root, '.claude', 'skills', linkedName))
    await expect(loadSkillDocument({ root }, linkedName)).rejects.toThrow(
      'Unknown skill: linked-skill'
    )
  })

  it('parses a process environment without exposing additional state', () => {
    expect(
      environmentFromProcess({
        [SKILL_RUNTIME_ROOT_ENV]: '/runtime/revision',
        [SKILL_RUNTIME_ALLOWED_NAMES_ENV]: '["literature-review"]'
      })
    ).toEqual({ root: '/runtime/revision', allowedNames: new Set(['literature-review']) })
  })
})
