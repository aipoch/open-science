import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { HostSkillsService } from '../skills/host-skills-service'
import { NOTEBOOK_RPC_TOOLS, NOTEBOOK_SYSTEM_PROMPT_APPEND } from './mcp-server'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('reported Connector Skill loading dead end', () => {
  it('explains the catalog boundary when reading a generated Connector Skill through host.skills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-loading-guidance-'))
    roots.push(root)
    // Reproduce a real generated document outside the managed Skill catalog. Its existence must
    // not grant the composer access to an arbitrary framework projection.
    const skillDir = join(root, 'codex', 'skills', 'mcp-genomes')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '# Genomes Connector\nDocumented methods.\n')
    const service = new HostSkillsService({
      storageRoot: root,
      catalog: {
        list: async () => [],
        withSkillRead: async () => undefined,
        publishPersonalDirectory: async () => {
          throw new Error('unexpected publish')
        },
        deletePublished: async () => {
          throw new Error('unexpected delete')
        }
      }
    })
    expect(await service.dispatch({ op: 'list' })).toEqual([])
    const failure = await service.dispatch({ op: 'read', params: { name: 'mcp-genomes' } }).then(
      () => {
        throw new Error('unexpected successful read')
      },
      (error: Error) => error.message
    )

    expect(failure).toContain('Unknown Skill: mcp-genomes')
    // Assert recovery semantics, not a new API name, error field, or exact proposed copy.
    expect(failure).toMatch(/Connector/i)
    expect(failure).toMatch(/load|rout|current.*tool/i)
  })

  it('gives a stopping rule with the captured Windows shell failure', () => {
    // Replay the supplied failure at the existing model-facing tool-result boundary. This is
    // deliberately not a claim to have reproduced Windows AppContainer initialization itself.
    const stderr =
      '#< CLIXML 拒绝访问。 <Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">对“FileSystem”提供程序执行 InitializeDefaultDrives 操作失败。_x000D__x000A_</S></Objs>'
    const raw = {
      runId: 'reported-shell-read',
      kernelKind: 'bash',
      status: 'failed',
      exitCode: 1,
      stderr
    }
    const tool = NOTEBOOK_RPC_TOOLS.find(({ name }) => name === 'bash_execute')!
    const result = tool.mapResult!(raw, {
      command:
        'Get-Content "C:\\Users\\example\\.open-science\\codex\\skills\\mcp-genomes\\SKILL.md" -Raw'
    })
    const visible = JSON.stringify(result)
    expect(visible).toContain('InitializeDefaultDrives')
    expect(visible).toMatch(/stop|do not retry|do not repeat/i)
    expect(raw.stderr).toBe(stderr)
  })

  it('distinguishes Connector Skill loading from the Notebook composer before caught errors occur', () => {
    // The reported REPL caught EPERM and returned {ok:false}; the run itself succeeds. Preventive
    // guidance must not depend on classifying arbitrary user JSON as a failed Notebook run.
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toMatch(/host\.skills/)
    expect(NOTEBOOK_SYSTEM_PROMPT_APPEND).toMatch(/Connector Skill|Connector.*document/i)
  })
})
