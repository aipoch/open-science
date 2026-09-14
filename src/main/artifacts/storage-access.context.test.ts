import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
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
