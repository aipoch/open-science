import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { researchVideoSessionSource } from './session-source'
import { stageResearchVideoSessionImages } from './session-images'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
async function fixture(): Promise<{
  root: string
  session: PersistedChatSession
  source: ReturnType<typeof researchVideoSessionSource>
}> {
  const root = await mkdtemp(join(tmpdir(), 'research-images-'))
  roots.push(root)
  await mkdir(join(root, 'artifacts', 'p', 's'), { recursive: true })
  const artifacts = await Promise.all(
    ['v1', 'v2', 'other-branch'].map(async (id) => {
      const path = join(root, 'artifacts', 'p', 's', id)
      await writeFile(path, id)
      return { id, kind: 'managed-file' as const, name: 'plot.png', path }
    })
  )
  const session = {
    id: 's',
    projectId: 'p',
    title: 'Study',
    artifacts,
    messages: ['v1', 'v2'].map((id) => ({
      id,
      role: 'agent',
      content: '![Observed plot](plot.png)',
      artifactIds: [id]
    }))
  } as unknown as PersistedChatSession
  return {
    root,
    session,
    source: researchVideoSessionSource(session, { projectId: 'p', sessionId: 's' })
  }
}
it('pins same-name images to the Version owned by each message without mutating history', async () => {
  const { root, session, source } = await fixture()
  const original = structuredClone(source)
  const staged = await stageResearchVideoSessionImages(
    source,
    session,
    root,
    join(root, 'files'),
    new AbortController().signal
  )
  const paths = staged.messages.map((m) => /\]\(([^)]+)\)/.exec(m.md)![1])
  expect(paths[0]).not.toBe(paths[1])
  expect(await readFile(join(root, paths[0]), 'utf8')).toBe('v1')
  expect(await readFile(join(root, paths[1]), 'utf8')).toBe('v2')
  expect(source).toEqual(original)
})
it('does not select images from another branch or trust a cross-Project file path', async () => {
  const { root, session, source } = await fixture()
  source.messages[0].artifactIds = []
  await expect(
    stageResearchVideoSessionImages(
      source,
      session,
      root,
      join(root, 'files'),
      new AbortController().signal
    )
  ).rejects.toThrow('available managed Artifact')
  source.messages[0].artifactIds = ['v1']
  await writeFile(join(root, 'outside.png'), 'private')
  session.artifacts![0].path = join(root, 'outside.png')
  await expect(
    stageResearchVideoSessionImages(
      source,
      session,
      root,
      join(root, 'files'),
      new AbortController().signal
    )
  ).rejects.toThrow('Invalid source path')
})
it('fails before publishing a changed immutable image', async () => {
  const { root, session, source } = await fixture()
  session.artifacts![0].sha256 = '0'.repeat(64)
  await expect(
    stageResearchVideoSessionImages(
      source,
      session,
      root,
      join(root, 'files'),
      new AbortController().signal
    )
  ).rejects.toThrow('content changed')
})
