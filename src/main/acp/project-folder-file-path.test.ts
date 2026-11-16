import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { mapProjectFolderAcpPath } from './project-folder-file-path'

it('maps normalized new filenames while preserving existing Session files and unrelated absolute paths', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'acp-project-filename-'))
  const cwd = join(temp, 'managed')
  const project = join(temp, 'project')
  await mkdir(cwd)
  await mkdir(project)
  await writeFile(join(cwd, 'existing.txt'), 'MANAGED')
  try {
    expect(await mapProjectFolderAcpPath(cwd, project, join(cwd, 'raw.csv'))).toBe(
      join(project, 'raw.csv')
    )
    expect(await mapProjectFolderAcpPath(cwd, project, join(cwd, 'existing.txt'))).toBe(
      join(cwd, 'existing.txt')
    )
    expect(await mapProjectFolderAcpPath(cwd, project, join(temp, 'unrelated.txt'))).toBe(
      join(temp, 'unrelated.txt')
    )
    expect(await mapProjectFolderAcpPath(cwd, project, 'raw.csv')).toBe('raw.csv')
    const traversal = `${cwd}/nested/../raw.csv`
    expect(await mapProjectFolderAcpPath(cwd, project, traversal)).toBe(traversal)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
