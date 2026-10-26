import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { resolveAllowedImportFilePath } from './storage-access'

it('keeps Literature read guidance separate from Artifact write guidance without changing allowed paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-context-'))
  try {
    await expect(
      resolveAllowedImportFilePath('missing.docx', [root], [root], 'literature')
    ).rejects.toThrow('Select an existing file')
    await expect(resolveAllowedImportFilePath('missing.docx', [root], [root])).rejects.toThrow(
      'write_artifact_file'
    )
    await writeFile(join(root, 'source.docx'), 'fixture')
    await expect(
      resolveAllowedImportFilePath('source.docx', [root], [root], 'literature')
    ).resolves.toBe(await realpath(join(root, 'source.docx')))
    await expect(
      resolveAllowedImportFilePath(
        join(root, 'source.docx'),
        [join(root, 'other')],
        [root],
        'literature'
      )
    ).rejects.toThrow('inside the current Notebook session or workspace')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('confines external absolute imports to unchanged granted folders without broadening relative or Literature access', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'artifact-grants-'))
  const root = await realpath(temporary)
  const granted = join(root, 'downloads')
  const workspace = join(root, 'workspace')
  const sibling = join(root, 'downloads-other')
  try {
    for (const directory of [join(granted, 'nested'), workspace, sibling])
      await mkdir(directory, { recursive: true })
    const source = join(granted, 'nested', 'file.txt')
    await writeFile(source, 'inside')
    const outside = join(sibling, 'secret.txt')
    await writeFile(outside, 'outside')
    const resolve = (path: string): Promise<string> =>
      resolveAllowedImportFilePath(path, [workspace], [workspace], 'artifact', [granted])
    await expect(resolve(source)).resolves.toBe(source)
    await expect(resolve(outside)).rejects.toThrow('outside allowed artifact import roots')
    await expect(resolve('../downloads/nested/file.txt')).rejects.toThrow(
      'outside allowed artifact import roots'
    )
    await expect(resolve('file.txt')).rejects.toThrow('does not exist')
    await expect(resolve(join(granted, 'missing.txt'))).rejects.toThrow('does not exist')
    await expect(resolve(join(granted, 'nested'))).rejects.toThrow('not a file')
    await expect(
      resolveAllowedImportFilePath(source, [workspace], [], 'literature', [granted])
    ).rejects.toThrow('inside the current Notebook session or workspace')
    // Directory links/junctions exercise containment on Windows without requiring file symlink privileges.
    await symlink(
      sibling,
      join(granted, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await expect(resolve(join(granted, 'escape', 'secret.txt'))).rejects.toThrow(
      'outside allowed artifact import roots'
    )
    await rename(granted, join(root, 'original-downloads'))
    await symlink(sibling, granted, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(resolve(join(granted, 'secret.txt'))).rejects.toThrow(
      'outside allowed artifact import roots'
    )
    await expect(resolve(outside)).rejects.toThrow('outside allowed artifact import roots')
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
