import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

// Reject traversal at the actual filesystem boundary. Evidence storage may enumerate its own
// managed records; observing the working directory must never enumerate any of its directories.
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: (...args: Parameters<typeof actual.readdir>) => {
      if (/[\\/]declared-data(?:[\\/]|$)/.test(String(args[0])))
        throw new Error('Project tree traversal forbidden')
      return actual.readdir(...args)
    }
  }
})

import { startWorkingFileObservation } from './working-file-observer'

let root: string | undefined
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

it('captures only declared files without filesystem tree traversal or recursive watches', async () => {
  root = await mkdtemp(join(tmpdir(), 'project-observation-'))
  const sessionRoot = join(root, 'notebook')
  const dataRoot = join(sessionRoot, 'data')
  const folder = join(root, 'declared-data')
  await mkdir(dataRoot, { recursive: true })
  await mkdir(folder)
  await writeFile(join(folder, 'raw.csv'), 'a,b\n1,2\n')
  const count = process.env.RUN_PROJECT_FOLDER_SCALE === '1' ? 120_000 : 64
  for (let start = 0; start < count; start += 128) {
    await Promise.all(
      Array.from({ length: Math.min(128, count - start) }, (_, offset) =>
        writeFile(join(folder, `unrelated-${start + offset}`), '')
      )
    )
  }
  const observation = await startWorkingFileObservation(
    {
      dataRoot,
      notebookSessionRoot: sessionRoot,
      cwd: folder,
      projectFolderRoot: folder,
      runId: 'run-1',
      language: 'python',
      code: 'x = open("raw.csv").read()\nopen("result.csv", "w").write(x)',
      observationMode: 'declared-paths'
    },
    {
      watchDirectory: () => {
        throw new Error('Recursive watch forbidden')
      }
    }
  )
  await writeFile(join(folder, 'result.csv'), 'a,b\n1,2\n')
  const result = await observation.finish()
  expect(result.workingFiles.map((file) => basename(file.relativePath))).toEqual(['result.csv'])
  expect(result.fileEvidence).toMatchObject({
    state: 'partial',
    externalPaths: 'partial',
    generationCount: 1
  })
  expect(result.fileEvidence.reasonCodes).toContain('absolute-path-not-frozen')
}, 120_000)

it('does not observe application records even when source code explicitly names them', async () => {
  root = await mkdtemp(join(tmpdir(), 'project-record-observation-'))
  const sessionRoot = join(root, 'notebook')
  const dataRoot = join(sessionRoot, 'data')
  const folder = join(root, 'declared-data')
  await mkdir(dataRoot, { recursive: true })
  await mkdir(join(folder, '.open-science/notebook'), { recursive: true })
  const record = join(folder, '.open-science/notebook/record.json')
  await writeFile(record, '{"before":true}')
  await symlink(
    join(folder, '.open-science'),
    join(folder, 'alias'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const observation = await startWorkingFileObservation(
    {
      dataRoot,
      notebookSessionRoot: sessionRoot,
      cwd: folder,
      projectFolderRoot: folder,
      runId: 'internal-record-isolation',
      language: 'python',
      observationMode: 'declared-paths',
      code: 'x = open(".open-science/notebook/record.json").read()\nopen(".open-science/notebook/record.json", "w").write("changed")\nopen("alias/notebook/record.json", "w").write("changed")'
    },
    {
      watchDirectory: () => {
        throw new Error('Recursive watch forbidden')
      }
    }
  )
  await writeFile(record, '{"after":true}')
  const result = await observation.finish()
  expect(result.workingFiles).toEqual([])
})
