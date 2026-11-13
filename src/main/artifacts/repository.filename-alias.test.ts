import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ArtifactRepository } from './repository'
import { ArtifactStorageAccess } from './storage-access'

let root: string | undefined
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(async () => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  vi.restoreAllMocks()
  if (root) await rm(root, { recursive: true, force: true })
})

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const source = (content: string): { kind: 'inline'; content: string; encoding: 'utf8' } => ({
  kind: 'inline',
  content,
  encoding: 'utf8'
})
const request = { projectId: 'p', sessionId: 's', runId: 'r' }
const names = ['研'.repeat(30) + '.MD', 'A'.repeat(251) + '.md']

const createFixture = async (): Promise<{ repository: ArtifactRepository; aliases: boolean }> => {
  root = await mkdtemp(join(tmpdir(), 'artifact-filename-alias-'))
  await writeFile(join(root, 'CaseProbe'), '')
  const aliases = await stat(join(root, 'caseprobe')).then(
    () => true,
    () => false
  )
  return { repository: new ArtifactRepository(root), aliases }
}

it.for(['case-folded', 'Windows native'])(
  'serializes %s aliases before resolving a newly created directory entry',
  async (kind) => {
    const { repository, aliases } = await createFixture()
    if (kind === 'Windows native') Object.defineProperty(process, 'platform', { value: 'win32' })
    const resolver = vi.spyOn(ArtifactStorageAccess.prototype, 'resolveArtifactFilename')
    const filename = names[0]
    const secondName = kind === 'Windows native' ? 'REPORT~1.MD' : filename.toLowerCase()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const inside = new Promise<void>((resolve) => {
      entered = resolve
    })
    const first = repository.withPendingFileTransaction(
      { ...request, filename, mimeType: 'text/markdown', source: source('first') },
      {},
      async () => {
        entered()
        await gate
      }
    )
    await inside
    const before = resolver.mock.calls.length
    const second = repository.writePendingFile({
      ...request,
      filename: secondName,
      mimeType: 'text/markdown',
      source: source('second')
    })
    try {
      // Only drain the lock's Promise continuations; the second filesystem lookup must wait.
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(resolver.mock.calls).toHaveLength(before)
    } finally {
      release()
      await Promise.all([first, second])
    }
    const files = await repository.listPendingRunFiles(request)
    // This exercises the Windows lock policy; the host volume still supplies real filesystem semantics.
    const expectedName = aliases && kind === 'case-folded' ? filename : secondName
    expect(files).toHaveLength(expectedName === filename ? 1 : 2)
    const latest = files.find((file) => file.name === expectedName)!
    expect(await readFile(latest.path, 'utf8')).toBe('second')
    expect(latest.mimeType).toBe('text/markdown')
  }
)

it.for(names)(
  'preserves routing through a filesystem case alias: %s',
  async (filename, context) => {
    const { repository, aliases } = await createFixture()
    if (!aliases) {
      context.skip()
      return
    }
    const original = await repository.writePendingFile({
      ...request,
      filename,
      mimeType: 'text/markdown',
      source: source('body')
    })
    await repository.ensurePendingVersionRouting({
      ...request,
      filename: filename.toLowerCase(),
      sourcePath: original.path,
      routing: {
        artifactId: 'a',
        versionId: 'v',
        versionNumber: 1,
        artifactRunId: 'r',
        checksum: digest('body'),
        mimeType: 'text/markdown'
      }
    })
    expect(
      await repository.findPendingVersionRouting({
        projectId: 'p',
        artifactId: 'a',
        versionId: 'v'
      })
    ).toMatchObject({ versionId: 'v', filename })
    await expect(
      repository.ensurePendingVersionRouting({
        ...request,
        filename: filename.toLowerCase(),
        sourcePath: original.path,
        routing: {
          artifactId: 'a',
          versionId: 'conflicting-version',
          versionNumber: 2,
          artifactRunId: 'r',
          checksum: digest('body'),
          mimeType: 'text/markdown'
        }
      })
    ).rejects.toThrow('conflicts with an existing Version')
    expect(await readdir(join(dirname(original.path), '.metadata'))).toHaveLength(1)
    const [finalized] = await repository.finalizeRunArtifacts({ ...request, messageId: 'm' })
    expect(finalized).toMatchObject({ name: filename, versionId: 'v', mimeType: 'text/markdown' })
    expect(
      await new ArtifactRepository(root!).listMessageFiles({
        projectId: 'p',
        sessionId: 's',
        messageId: 'm'
      })
    ).toMatchObject([{ versionId: 'v' }])
  }
)

it.for(names)(
  'restores both bytes and metadata after an alias overwrite fails: %s',
  async (filename, context) => {
    const { repository, aliases } = await createFixture()
    if (!aliases) {
      context.skip()
      return
    }
    const original = await repository.writePendingFile({
      ...request,
      filename,
      mimeType: 'text/markdown',
      source: source('body')
    })
    await repository.ensurePendingVersionRouting({
      ...request,
      filename,
      sourcePath: original.path,
      routing: {
        artifactId: 'a',
        versionId: 'v',
        versionNumber: 1,
        artifactRunId: 'r',
        checksum: digest('body'),
        mimeType: 'text/markdown'
      }
    })
    await expect(
      repository.withPendingFileTransaction(
        {
          ...request,
          filename: filename.toLowerCase(),
          mimeType: 'text/plain',
          source: source('rejected')
        },
        {},
        async () => {
          throw new Error('publication failed')
        }
      )
    ).rejects.toThrow('publication failed')
    expect(await readFile(original.path, 'utf8')).toBe('body')
    expect(await repository.listPendingRunFiles(request)).toMatchObject([
      { name: filename, versionId: 'v', mimeType: 'text/markdown' }
    ])
    expect(await readdir(dirname(original.path))).toEqual(['.metadata', filename])
    expect(await readdir(join(dirname(original.path), '.metadata'))).toHaveLength(1)
  }
)

it('keeps case-distinct long files independent on a case-sensitive filesystem', async (context) => {
  const { repository, aliases } = await createFixture()
  if (aliases) {
    context.skip()
    return
  }
  const filename = names[0]
  for (const [index, name] of [filename, filename.toLowerCase()].entries()) {
    const file = await repository.writePendingFile({
      ...request,
      filename: name,
      mimeType: 'text/markdown',
      source: source(String(index))
    })
    await repository.ensurePendingVersionRouting({
      ...request,
      filename: name,
      sourcePath: file.path,
      routing: {
        artifactId: `a${index}`,
        versionId: `v${index}`,
        versionNumber: 1,
        artifactRunId: 'r',
        checksum: digest(String(index)),
        mimeType: 'text/markdown'
      }
    })
  }
  const files = await repository.listPendingRunFiles(request)
  expect(files).toHaveLength(2)
  for (const [index, name] of [filename, filename.toLowerCase()].entries()) {
    expect(files.find((file) => file.name === name)?.versionId).toBe(`v${index}`)
    expect(await readFile(files.find((file) => file.name === name)!.path, 'utf8')).toBe(
      String(index)
    )
  }
})
