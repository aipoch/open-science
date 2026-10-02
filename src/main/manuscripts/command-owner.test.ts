import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createManuscriptCommandOwner } from './command-owner'

const temporaryRoots: string[] = []

const createFakeQuarto = async (root: string): Promise<{ path: string; argvLog: string }> => {
  const path = join(root, 'quarto')
  const argvLog = join(root, 'argv.log')
  await writeFile(
    path,
    `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(argvLog)}
output=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--output' ]; then
    shift
    output="$1"
  fi
  shift
done
printf 'fake quarto output' > "$output"
printf 'Quarto 1.7.32\\n'
`,
    'utf8'
  )
  await chmod(path, 0o755)
  return { path, argvLog }
}

const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'manuscript-owner-test-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('manuscript command owner', () => {
  it.each(['html', 'pdf', 'docx'] as const)(
    'renders %s through a detected Quarto executable with explicit argv and output',
    async (format) => {
      const root = await createRoot()
      const { path: quartoPath, argvLog } = await createFakeQuarto(root)
      const approval = vi.fn(async () => true)
      const owner = createManuscriptCommandOwner({
        discoverQuarto: async () => ({
          available: true,
          path: quartoPath,
          version: '1.7.32'
        }),
        resolveVersionDescriptors: vi.fn(async () => []),
        exportBibtex: vi.fn(async () => ({ content: '', citationKeys: [] })),
        approve: approval
      })

      const result = await owner.render({
        projectId: 'project-1',
        appSessionId: 'session-1',
        workingDirectory: root,
        filename: 'paper.qmd',
        format,
        content: `---\ntitle: Paper\n---\n\n# Results\n`
      })

      expect(Buffer.from(result.dataBase64, 'base64').toString('utf8')).toBe('fake quarto output')
      expect(result.filename).toBe(`paper.${format}`)
      const argv = (await readFile(argvLog, 'utf8')).trim().split('\n')
      expect(argv[0]).toBe('render')
      expect(argv[1]).toMatch(/\.qmd$/)
      expect(argv).toEqual(
        expect.arrayContaining([
          '--to',
          format,
          '--output',
          expect.stringMatching(new RegExp(`\\.${format}$`)),
          '--no-execute'
        ])
      )
      expect(approval).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          title: 'Run Quarto manuscript render?',
          rawInput: expect.objectContaining({ format })
        })
      )
      expect(await readdir(root)).toEqual(expect.arrayContaining(['quarto', 'argv.log']))
      expect((await readdir(root)).some((name) => name.includes('open-science-manuscript'))).toBe(
        false
      )
    }
  )

  it('fails with an actionable message without invoking another format path when Quarto is missing', async () => {
    const root = await createRoot()
    const approval = vi.fn(async () => true)
    const owner = createManuscriptCommandOwner({
      discoverQuarto: async () => ({
        available: false,
        reason:
          'Quarto was not found. Install Quarto and ensure "quarto" is on PATH, then retry. Other preview and export formats are unaffected.'
      }),
      resolveVersionDescriptors: vi.fn(async () => []),
      exportBibtex: vi.fn(async () => ({ content: '', citationKeys: [] })),
      approve: approval
    })

    await expect(
      owner.render({
        projectId: 'project-1',
        appSessionId: 'session-1',
        workingDirectory: root,
        format: 'pdf',
        content: '# Paper\n'
      })
    ).rejects.toThrow(/Install Quarto.*PATH.*Other preview and export formats are unaffected/u)
    expect(approval).not.toHaveBeenCalled()
  })

  it('always disables Quarto execution even for a legacy caller request', async () => {
    const root = await createRoot()
    const { path: quartoPath, argvLog } = await createFakeQuarto(root)
    const owner = createManuscriptCommandOwner({
      discoverQuarto: async () => ({
        available: true,
        path: quartoPath,
        version: '1.7.32'
      }),
      resolveVersionDescriptors: vi.fn(async () => []),
      exportBibtex: vi.fn(async () => ({ content: '', citationKeys: [] })),
      approve: async () => true
    })

    await owner.render({
      projectId: 'project-1',
      appSessionId: 'session-1',
      workingDirectory: root,
      format: 'html',
      content: '# Paper\n',
      execute: true
    } as never)

    expect((await readFile(argvLog, 'utf8')).trim().split('\n')).toContain('--no-execute')
  })

  it('removes its owned working directory when preparation fails before render', async () => {
    const workDirectoryPrefix = 'open-science-manuscript-work-'
    const before = (await readdir(tmpdir())).filter((name) => name.startsWith(workDirectoryPrefix))
    const owner = createManuscriptCommandOwner({
      discoverQuarto: async () => ({
        available: true,
        path: '/fake/quarto',
        version: '1.7.32'
      }),
      resolveVersionDescriptors: vi.fn(async () => []),
      exportBibtex: vi.fn(async () => ({ content: '', citationKeys: [] })),
      approve: async () => true
    })

    await expect(
      owner.render({
        projectId: 'project-1',
        appSessionId: 'session-1',
        format: 'html',
        content: `---
open-science:
  artifact-references:
    fig-missing:
      artifact-id: artifact-1
      version-id: version-1
      checksum: ${'a'.repeat(64)}
---

See @fig-missing.
`
      })
    ).rejects.toMatchObject({ code: 'UNKNOWN_ARTIFACT_VERSION' })

    const after = (await readdir(tmpdir())).filter((name) => name.startsWith(workDirectoryPrefix))
    expect(after).toEqual(before)
  })

  it('does not run Quarto when the command approval is denied', async () => {
    const root = await createRoot()
    const { path: quartoPath, argvLog } = await createFakeQuarto(root)
    const owner = createManuscriptCommandOwner({
      discoverQuarto: async () => ({
        available: true,
        path: quartoPath,
        version: '1.7.32'
      }),
      resolveVersionDescriptors: vi.fn(async () => []),
      exportBibtex: vi.fn(async () => ({ content: '', citationKeys: [] })),
      approve: async () => false
    })

    await expect(
      owner.render({
        projectId: 'project-1',
        appSessionId: 'session-1',
        workingDirectory: root,
        format: 'html',
        content: '# Paper\n'
      })
    ).rejects.toThrow('Quarto manuscript render was not approved.')
    await expect(readFile(argvLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
