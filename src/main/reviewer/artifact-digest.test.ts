import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'
import { resolveTurnScopeWithArtifactDigests } from './artifact-digest'

let storageRoot: string | undefined

afterEach(async () => {
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

// A session whose agent turn produced one artifact, addressed by the reviewer version id layout
// (`<sessionId>:<messageId>:<filename>` -> <project>/<sessionId>/<messageId>/<filename>).
const buildSession = (): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Session',
  cwd: '/tmp',
  status: 'idle',
  messages: [
    {
      id: 'u1',
      role: 'user',
      content: 'go',
      status: 'complete',
      eventIds: [],
      createdAt: 1000,
      updatedAt: 1000
    },
    {
      id: 'a1',
      role: 'agent',
      content: 'done',
      status: 'complete',
      eventIds: [],
      artifactIds: ['session-1:a1:report.csv'],
      createdAt: 1002,
      updatedAt: 1002
    }
  ],
  createdAt: 1000,
  updatedAt: 1002
})

const writeArtifact = async (root: string, contents: string): Promise<void> => {
  const dir = join(root, 'artifacts', 'project-1', 'session-1', 'a1')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'report.csv'), contents, 'utf8')
}

describe('resolveTurnScopeWithArtifactDigests', () => {
  it('invalidates the producing block hash when the artifact bytes change on disk', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'reviewer-digest-'))
    const session = buildSession()

    await writeArtifact(storageRoot, 'a,b\n1,2\n')
    const before = await resolveTurnScopeWithArtifactDigests(session, 'a1', storageRoot)

    // An external process rewrites the artifact; the id is unchanged but the bytes differ.
    await writeArtifact(storageRoot, 'a,b\n9,9\n')
    const after = await resolveTurnScopeWithArtifactDigests(session, 'a1', storageRoot)

    const hashOf = (
      scope: Awaited<ReturnType<typeof resolveTurnScopeWithArtifactDigests>>
    ): string | undefined => scope.blocks.find((block) => block.sourceId === 'a1')?.contentHash

    expect(hashOf(after)).not.toBe(hashOf(before))
  })

  it('is stable when the artifact bytes are unchanged', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'reviewer-digest-'))
    const session = buildSession()
    await writeArtifact(storageRoot, 'a,b\n1,2\n')

    const first = await resolveTurnScopeWithArtifactDigests(session, 'a1', storageRoot)
    const second = await resolveTurnScopeWithArtifactDigests(session, 'a1', storageRoot)

    const hashOf = (
      scope: Awaited<ReturnType<typeof resolveTurnScopeWithArtifactDigests>>
    ): string | undefined => scope.blocks.find((block) => block.sourceId === 'a1')?.contentHash

    expect(hashOf(first)).toBe(hashOf(second))
  })

  it('streams a large artifact fully (a late-byte edit still changes the hash)', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'reviewer-digest-'))
    const session = buildSession()
    const dir = join(storageRoot, 'artifacts', 'project-1', 'session-1', 'a1')
    await mkdir(dir, { recursive: true })

    // ~8 MB: comfortably larger than a stream chunk, so hashing must consume the whole file, not a head.
    const big = Buffer.alloc(8 * 1024 * 1024, 7)
    await writeFile(join(dir, 'report.csv'), big)
    const before = await resolveTurnScopeWithArtifactDigests(session, 'a1', storageRoot)

    // Flip the very last byte only — a head-only or truncated read would miss this.
    big[big.length - 1] = 8
    await writeFile(join(dir, 'report.csv'), big)
    const after = await resolveTurnScopeWithArtifactDigests(session, 'a1', storageRoot)

    const hashOf = (
      scope: Awaited<ReturnType<typeof resolveTurnScopeWithArtifactDigests>>
    ): string | undefined => scope.blocks.find((block) => block.sourceId === 'a1')?.contentHash

    expect(hashOf(after)).not.toBe(hashOf(before))
  })

  it('hashes more artifacts than the concurrency limit and reflects a per-artifact edit', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'reviewer-digest-'))
    const names = Array.from({ length: 10 }, (_, index) => `file-${index}.txt`)
    const session: PersistedChatSession = {
      ...buildSession(),
      messages: [
        buildSession().messages[0],
        { ...buildSession().messages[1], artifactIds: names.map((name) => `session-1:a1:${name}`) }
      ]
    }
    const dir = join(storageRoot, 'artifacts', 'project-1', 'session-1', 'a1')
    await mkdir(dir, { recursive: true })
    for (const name of names) await writeFile(join(dir, name), `content of ${name}`)

    const first = await resolveTurnScopeWithArtifactDigests(session, 'a1', storageRoot)
    const second = await resolveTurnScopeWithArtifactDigests(session, 'a1', storageRoot)

    const hashOf = (
      scope: Awaited<ReturnType<typeof resolveTurnScopeWithArtifactDigests>>
    ): string | undefined => scope.blocks.find((block) => block.sourceId === 'a1')?.contentHash

    // All 10 hashed deterministically across the batched passes.
    expect(hashOf(first)).toBe(hashOf(second))

    // Editing any one of them (past the first batch) still changes the block hash.
    await writeFile(join(dir, 'file-9.txt'), 'edited')
    const edited = await resolveTurnScopeWithArtifactDigests(session, 'a1', storageRoot)
    expect(hashOf(edited)).not.toBe(hashOf(first))
  })
})
