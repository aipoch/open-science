import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('inventories retained and compact fork layouts and withholds estimates for damaged metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fork-inventory-'))
  const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
  const records = '{}'
  const payload = 'retained content'
  const object = 'objects/' + hash(payload)
  const manifest = JSON.stringify({
    format: 'open-science-session',
    schemaVersion: 1,
    source: { projectId: 'p', sessionId: 'original' },
    inventory: [
      { path: 'records.json', sizeBytes: records.length, checksum: hash(records) },
      { path: object, sizeBytes: payload.length, checksum: hash(payload) }
    ]
  })
  try {
    for (const sessionId of ['plain', 'log', 'compact', 'damaged']) {
      const session = join(root, 'artifacts', 'p', sessionId)
      const fork = join(session, '.session-fork')
      const usesLog = sessionId !== 'plain'
      const metadata = join(fork, usesLog ? 'origin-metadata' : 'source')
      await mkdir(metadata, { recursive: true })
      await writeFile(join(session, '.session-package-owner'), 'operation')
      await writeFile(
        join(fork, 'receipt.json'),
        JSON.stringify({
          schemaVersion: 1,
          importId: 'operation',
          projectId: 'p',
          sessionId,
          sourceProjectId: 'p',
          sourceSessionId: 'original',
          manifestChecksum: hash(manifest),
          ...(usesLog ? { nativeLogOrigin: true } : {})
        })
      )
      await writeFile(join(metadata, 'manifest.json'), manifest)
      await writeFile(join(metadata, 'records.json'), sessionId === 'damaged' ? '[]' : records)
      if (sessionId === 'plain' || sessionId === 'log') {
        const source = join(fork, 'source')
        await mkdir(join(source, 'objects'), { recursive: true })
        await writeFile(join(source, object), payload)
        await writeFile(join(source, 'records.json'), records)
        await writeFile(join(source, 'manifest.json'), manifest)
      }
    }
    const run = spawnSync(
      process.execPath,
      [resolve('scripts/inspect-session-fork-snapshots.mjs'), root],
      { encoding: 'utf8' }
    )
    expect(run.status, run.stderr).toBe(1)
    const result = JSON.parse(run.stdout)
    const metadataBytes = Buffer.byteLength(manifest + records)
    expect(result.forks).toHaveLength(3)
    expect(result.forks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: 'plain',
          metadataBytesInSource: metadataBytes,
          candidateBytes: payload.length
        }),
        expect.objectContaining({
          sessionId: 'log',
          metadataBytesInSource: 0,
          candidateBytes: payload.length + metadataBytes
        }),
        expect.objectContaining({ sessionId: 'compact', sourceBytes: 0, candidateBytes: 0 })
      ])
    )
    expect(result.issues).toEqual([
      { projectId: 'p', sessionId: 'damaged', issue: 'Origin records checksum mismatch' }
    ])
    expect(result.candidateBytes).toBe(payload.length * 2 + metadataBytes)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
