import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { listRayJobOutputs, reserveRayOutputDirectory } from './ray-shared-outputs'

it('recovers only its own reservation and refuses a replacement before collection', async () => {
  const sharedRoot = await mkdtemp(join(tmpdir(), 'ray-output-'))
  const scope = { sharedRoot, runId: randomUUID() }
  const nonce = randomUUID()
  const path = join(sharedRoot, scope.runId)
  try {
    const identity = await reserveRayOutputDirectory(scope, nonce)
    expect(await reserveRayOutputDirectory(scope, nonce)).toEqual(identity)
    await expect(reserveRayOutputDirectory(scope, randomUUID())).rejects.toThrow(/owned/)
    await writeFile(join(path, 'result.txt'), 'abc')
    expect(await listRayJobOutputs({ ...scope, ...identity })).toEqual([
      { path: 'result.txt', size_bytes: 3 }
    ])
    await rename(path, path + '-original')
    await mkdir(path)
    await expect(listRayJobOutputs({ ...scope, ...identity })).rejects.toThrow(/replaced/)
    await expect(reserveRayOutputDirectory(scope, nonce)).rejects.toThrow()
  } finally {
    await rm(sharedRoot, { recursive: true, force: true })
  }
})
