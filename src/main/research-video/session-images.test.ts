import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { initializeProjectRecordStorage } from '../projects/record-storage'
import { researchVideoSessionSource } from './session-source'
import { stageResearchVideoSessionImages } from './session-images'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
async function fixture(customFolder = false): Promise<{
  root: string
  session: PersistedChatSession
  source: ReturnType<typeof researchVideoSessionSource>
}> {
  const root = await mkdtemp(join(tmpdir(), 'research-images-'))
  roots.push(root)
  let recordRoot = root
  if (customFolder) {
    const folder = join(await realpath(root), 'project')
    await mkdir(folder)
    await initializeProjectRecordStorage(root, folder, {
      format: 'open-science-project',
      version: 2,
      outputLayout: 'session-v1',
      projectId: 'p',
      name: 'Study',
      createdAt: 1
    })
    recordRoot = join(folder, '.open-science')
  }
  const artifactDirectory = join(recordRoot, 'artifacts', 'p', 's')
  await mkdir(artifactDirectory, { recursive: true })
  const artifacts = await Promise.all(
    ['v1', 'v2', 'other-branch'].map(async (id) => {
      const path = join(artifactDirectory, id)
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
it.each([false, true])(
  'pins same-name images to the Version owned by each message with custom folder=%s',
  async (customFolder) => {
    const { root, session, source } = await fixture(customFolder)
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
  }
)
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
it.skipIf(process.platform === 'win32').each([false, true])(
  'applies the linked-image policy for custom folder=%s',
  async (customFolder) => {
    const { root, session, source } = await fixture(customFolder)
    const artifact = session.artifacts![0]
    const link = artifact.path + '.link'
    await symlink(artifact.path, link)
    artifact.path = link
    const stage = stageResearchVideoSessionImages(
      source,
      session,
      root,
      join(root, 'files'),
      new AbortController().signal
    )
    if (customFolder)
      await expect(stage).rejects.toThrow('Research record paths cannot contain links')
    else
      await expect(stage).resolves.toMatchObject({
        messages: [
          expect.objectContaining({ md: expect.stringContaining('files/') }),
          expect.objectContaining({ md: expect.stringContaining('files/') })
        ]
      })
  }
)
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

it('stages only linked replay images and records missing bytes without substituting another version', async () => {
  const { root, session } = await fixture()
  const source = researchVideoSessionSource(session, {
    projectId: 'p',
    sessionId: 's',
    mode: 'operation-replay'
  })
  const signal = new AbortController().signal
  await rm(session.artifacts![1].path)
  const staged = await stageResearchVideoSessionImages(
    source,
    session,
    root,
    join(root, 'files'),
    signal
  )
  const results = staged.replay!.events.filter((e) => e.kind === 'result')
  expect(results[0].image).toMatch(/^[a-f0-9]{64}\.png$/)
  expect(await readFile(join(root, 'files', results[0].image!), 'utf8')).toBe('v1')
  expect(results[1].image).toBeUndefined()
  expect(staged.replay!.omissions).toEqual(['Image unavailable: plot.png'])
  const resolved = await stageResearchVideoSessionImages(
    source,
    session,
    root,
    undefined,
    signal,
    undefined,
    async (_projectId, artifact) => {
      if (artifact.id === 'v2')
        throw new Error('Version content unavailable', {
          cause: Object.assign(new Error('Missing file'), { code: 'ENOENT' })
        })
      return artifact.path
    }
  )
  expect(resolved.replay!.omissions).toEqual(['Image unavailable: plot.png'])

  expect(source.replay!.events.every((e) => !e.image)).toBe(true)
  session.artifacts![0].sha256 = '0'.repeat(64)
  await expect(
    stageResearchVideoSessionImages(source, session, root, undefined, signal)
  ).rejects.toThrow('content changed')
  session.artifacts![0].path = join(root, 'outside.png')
  await expect(
    stageResearchVideoSessionImages(source, session, root, undefined, signal)
  ).rejects.toThrow('Invalid source path')
})

it('freezes linked result text with checksum validation and leaves unlinked files out', async () => {
  const { root, session } = await fixture()
  const { operationReplaySource } = await import('./replay-source')
  session.artifacts![0].name = 'summary.csv'
  await writeFile(session.artifacts![0].path, 'Name,Value\nNVDA,42')
  session.messages[0].artifactIds = ['v1']
  session.messages = [session.messages[0]]
  const source = operationReplaySource(session, {
    projectId: 'p',
    sessionId: 's',
    mode: 'operation-replay'
  })
  const staged = await stageResearchVideoSessionImages(
    source,
    session,
    root,
    undefined,
    new AbortController().signal
  )
  expect(staged.replay!.events.find((e) => e.kind === 'result')?.previewText).toBe(
    'Name,Value\nNVDA,42'
  )
  expect(source.replay!.events.some((e) => e.previewText)).toBe(false)
  session.artifacts![0].sha256 = 'changed'
  await expect(
    stageResearchVideoSessionImages(source, session, root, undefined, new AbortController().signal)
  ).rejects.toThrow('content changed')
})
