import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { stageRayJobOutputs } from './ray-job-outputs'

it('collects only declared output bytes and discards an entire failed local attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ray-shared-'))
  try {
    const stagingDirectory = join(root, 'archive')
    const job = join(root, 'attempt-1')
    await mkdir(stagingDirectory)
    await mkdir(join(job, 'nested'), { recursive: true })
    const bytes = Buffer.from([2, 0, 255])
    const file = join(job, 'nested', 'out.bin')
    await writeFile(file, bytes)
    const request = {
      sharedRoot: root,
      stagingDirectory,
      submissionId: 'attempt-1',
      maxBytes: 3,
      paths: ['nested/out.bin']
    }
    await expect(
      stageRayJobOutputs({ ...request, paths: ['nested/out.bin', 'missing'] })
    ).rejects.toThrow()
    expect(await readdir(stagingDirectory)).toEqual([])
    await expect(stageRayJobOutputs({ ...request, maxBytes: 2 })).rejects.toThrow()
    const [output] = await stageRayJobOutputs(request)
    expect(output.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(await readFile(output.localPath)).toEqual(bytes)
    await link(file, join(job, 'alias'))
    await expect(stageRayJobOutputs(request)).rejects.toThrow('unsafe')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
