import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi, type Mock } from 'vitest'
import { ImageResultStore } from './result-store'
import { ImageModelError } from './contract'

const context = {
  projectId: 'project',
  sessionId: 'session',
  invocationId: 'request',
  frameworkId: 'test'
}
const fingerprint = 'a'.repeat(64)
const output = {
  bytes: Buffer.from([137, 80, 78, 71]),
  mime: 'image/png' as const,
  width: 1,
  height: 1,
  serviceId: 'service',
  presetId: 'preset',
  model: 'model',
  parameters: { n: 1 }
}
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(): Promise<{
  root: string
  store: ImageResultStore
  createStore: () => ImageResultStore
  directory: string
  content: string
  logicalFile: { sessionId: string }
  openVersion: Mock<ConstructorParameters<typeof ImageResultStore>[1]>
  readRange: Mock<() => Promise<Buffer>>
  close: Mock<() => Promise<void>>
}> {
  const root = await mkdtemp(join(tmpdir(), 'image-results-'))
  roots.push(root)
  const content = join(root, 'alternate-content-layout')
  const readRange = vi.fn(() => readFile(content))
  const close = vi.fn(async () => {})
  const logicalFile = {
    source: 'artifact' as const,
    id: 'artifact',
    projectId: context.projectId,
    sessionId: context.sessionId,
    displayName: 'result.png',
    currentVersionId: 'version'
  }
  const version = { checksum: createHash('sha256').update(output.bytes).digest('hex') }
  const openVersion = vi.fn<ConstructorParameters<typeof ImageResultStore>[1]>(async () => ({
    logicalFile,
    version,
    size: output.bytes.length,
    readRange,
    verifyUnchanged: async () => {},
    close
  }))
  const createStore = (): ImageResultStore => new ImageResultStore(() => root, openVersion)
  return {
    root,
    store: createStore(),
    createStore,
    directory: join(root, 'artifacts', 'project', 'session', '.image-results'),
    content,
    logicalFile,
    openVersion,
    readRange,
    close
  }
}
it('stores only request metadata and replays published Version bytes after restart', async () => {
  const { store, createStore, content, directory, openVersion, logicalFile, readRange, close } =
    await fixture()
  await expect(store.inspectReceipt(context)).resolves.toBe(false)
  await store.begin(context, fingerprint)
  await expect(createStore().inspectReceipt(context)).resolves.toBe(true)
  await expect(createStore().recover(context)).rejects.toMatchObject({
    code: 'OUTCOME_UNKNOWN'
  })
  await expect(store.recover(context, 'b'.repeat(64))).rejects.toMatchObject({
    code: 'INVALID_REQUEST'
  })
  await writeFile(content, output.bytes)
  const published = {
    artifactId: 'artifact',
    versionId: 'version',
    versionNumber: 2,
    size: output.bytes.length
  }
  await store.published(context, output, published)
  const [name] = await readdir(directory)
  expect(JSON.parse(await readFile(join(directory, name), 'utf8'))).toMatchObject({
    published: { artifactId: 'artifact', versionId: 'version' }
  })
  expect(JSON.parse(await readFile(join(directory, name), 'utf8')).bytes).toBeUndefined()
  expect(JSON.parse(await readFile(join(directory, name), 'utf8')).published).toEqual({
    artifactId: 'artifact',
    versionId: 'version'
  })
  await expect(createStore().recover(context)).resolves.toEqual(output)
  expect(openVersion).toHaveBeenCalledWith(context, {
    artifactId: 'artifact',
    versionId: 'version'
  })
  expect(close).toHaveBeenCalledOnce()
  logicalFile.sessionId = 'different-session'
  await expect(store.recover(context)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
  expect(readRange).toHaveBeenCalledOnce()
  logicalFile.sessionId = context.sessionId
  await writeFile(content, 'bad')
  await expect(store.recover(context)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
})
it('preserves known provider failure and never recreates an owner deleted after submission', async () => {
  const { root, store } = await fixture()
  await store.begin(context, fingerprint)
  await store.fail(
    context,
    fingerprint,
    new ImageModelError('QUOTA_EXCEEDED', 'private upstream body', 429)
  )
  await expect(store.recover(context)).rejects.toMatchObject({
    code: 'QUOTA_EXCEEDED',
    httpStatus: 429
  })
  await expect(store.inspectReceipt(context)).rejects.toMatchObject({
    code: 'QUOTA_EXCEEDED',
    httpStatus: 429
  })
  await rm(join(root, 'artifacts/project/session'), { recursive: true })
  await expect(
    store.published(context, output, { artifactId: 'artifact', versionId: 'version' })
  ).rejects.toThrow('unavailable')
  await expect(store.recover(context)).resolves.toBeUndefined()
})
it('rejects a symlink in place of the receipt without opening any Version', async () => {
  const { store, directory, openVersion, content } = await fixture()
  await store.begin(context, fingerprint)
  await writeFile(content, output.bytes)
  const receipt = join(
    directory,
    createHash('sha256').update(context.invocationId).digest('hex') + '.json'
  )
  await rm(receipt)
  await symlink(content, receipt)
  await expect(store.recover(context)).rejects.toThrow('Unsafe')
  expect(openVersion).not.toHaveBeenCalled()
})
