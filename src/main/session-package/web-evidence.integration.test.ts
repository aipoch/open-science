import { validatePackageRecords } from './validation'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { initDataRoot } from '../storage-root'
import {
  createProvenanceTestFixture,
  createArtifactVersionRequest
} from '../artifacts/provenance-test-fixtures'
import { SessionRepository } from '../session-persistence/repository'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'
import type { PersistedToolActivity } from '../../shared/session-message-contract'
import type { WebResult } from '../../shared/web-tools'
import type { PackageSelectionSummary, SessionPackageManifest } from '../../shared/session-package'
import { WebSnapshotStore, webTextHash } from '../web/snapshot-store'
import { webEvidenceScope } from '../web/evidence-lifecycle'
import { SessionPackageService } from './service'
import { parseNativeRecords, mapPackageReferences } from './native-snapshot'
import { packageEntry, readPackageArchive, readPackageJson, writePackageArchive } from './archive'
import { writePackageRoCrateMetadata } from './ro-crate'
import type { PackageRecords } from './records-contract'
import { readSession } from './inspection'
import {
  resolveReviewedWebPolicy,
  type HostWebDataPolicy,
  type WebSnapshotInput
} from './web-evidence'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false }
}))

type Fixture = Awaited<ReturnType<typeof createProvenanceTestFixture>>
const fixtures: Fixture[] = []
const services: SessionPackageService[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()))
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()))
})
const now = '2026-11-16T08:00:00.000Z'
const articleTitle = 'Article "quoted"\nsecond line'
const snapshot: WebSnapshotInput = {
  snapshotId: '11111111-1111-4111-8111-111111111111',
  invocationId: 'host-fetch',
  originalUrl: 'https://example.org/source',
  finalUrl: 'https://example.org/article',
  fetchedAt: now,
  contentType: 'text/plain',
  extractorVersion: 'fixture-v1',
  extractionMethod: 'plain_text',
  extractionQuality: 'normal',
  text: 'Independent fetched article excerpt.\nUnread complete original body.',
  sha256: webTextHash('Independent fetched article excerpt.\nUnread complete original body.')
}
const result = (): WebResult => ({
  schema: 'open-science.web.v1',
  operation: 'fetch',
  invocation_id: snapshot.invocationId,
  status: 'ok',
  request: { url: snapshot.originalUrl },
  retrieved_at: now,
  duration_ms: 4,
  sources: [
    {
      source_id: 'source-id',
      url: snapshot.finalUrl!,
      title: articleTitle,
      evidence_kind: 'page_extract'
    }
  ],
  document: {
    snapshot_id: snapshot.snapshotId,
    final_url: snapshot.finalUrl!,
    fetched_at: now,
    content_type: snapshot.contentType,
    extraction_method: snapshot.extractionMethod,
    extraction_quality: snapshot.extractionQuality,
    extractor_version: snapshot.extractorVersion,
    sha256: snapshot.sha256,
    text: 'Independent fetched article excerpt.',
    start_line: 1,
    end_line: 1,
    total_lines: 2,
    truncated: true,
    next_cursor: 'sender-private-cursor'
  }
})
const activity = (): PersistedToolActivity => ({
  id: snapshot.invocationId,
  kind: 'tool',
  title: 'Web Fetch',
  appOwned: true,
  providerToolName: 'mcp__open_science_web__web_fetch',
  executionInvocationId: snapshot.invocationId,
  promptMessageId: 'prompt',
  status: 'completed',
  sortIndex: 0,
  eventIds: [],
  createdAt: 2,
  updatedAt: 3,
  rawInput: result().request,
  rawOutput: result(),
  toolContent: [{ type: 'content', content: { type: 'text', text: JSON.stringify(result()) } }],
  webInvocation: { attempt: 1, configGeneration: 'private-generation', retryEligible: true }
})
const session = (): PersistedChatSession =>
  materializeSessionConversationGraph({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Portable Web research',
    cwd: '',
    status: 'idle',
    createdAt: 1,
    updatedAt: 4,
    messages: [
      {
        id: 'prompt',
        role: 'user',
        content: 'Read the public article.',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'answer',
        role: 'agent',
        content: 'The analysis is saved.',
        status: 'complete',
        eventIds: [],
        createdAt: 4,
        updatedAt: 4,
        completedAt: 4
      }
    ],
    activities: [activity()]
  })
const allowedPolicy: HostWebDataPolicy = {
  version: 'fixture-reviewed-sharing-v1',
  components: {
    query_history: 'allow',
    source_manifest: 'allow',
    provider_excerpt: 'allow',
    fetch_body: 'allow'
  }
}
const fixture = async (): Promise<Fixture> => {
  const value = await createProvenanceTestFixture()
  fixtures.push(value)
  await value.client.project.create({ data: { id: 'project-1', name: 'Web research' } })
  return value
}
const storeSession = async (
  { storageRoot }: Fixture,
  input = session()
): Promise<SessionRepository> => {
  initDataRoot(storageRoot)
  const repository = new SessionRepository(storageRoot)
  await repository.saveSession(input)
  return repository
}
const createService = (
  value: Fixture,
  webEvidence: NonNullable<ConstructorParameters<typeof SessionPackageService>[0]['webEvidence']>
): SessionPackageService => {
  const instance = new SessionPackageService({
    storageRoot: value.storageRoot,
    getClient: async () => value.client,
    webEvidence
  })
  services.push(instance)
  return instance
}
const service = (value: Fixture, allow = false, snapshotValue = snapshot): SessionPackageService =>
  createService(value, {
    ...(allow ? { resolvePolicy: () => allowedPolicy } : {}),
    loadSnapshot: async () => snapshotValue
  })
const importPackage = (
  importer: SessionPackageService,
  archive: string
): ReturnType<SessionPackageService['importFrom']> =>
  importer.importFrom(archive, undefined, undefined, undefined, { projectId: 'project-1' })
const addPngVersion = async (
  value: Fixture,
  filename: string,
  content: string,
  writeOperationId?: string
): Promise<void> => {
  await value.stagePng(content, filename)
  await value.repository.createVersion(
    createArtifactVersionRequest({
      filename,
      ...(writeOperationId === undefined ? {} : { writeOperationId })
    })
  )
}
const unpack = async (
  path: string,
  directory: string
): Promise<{
  manifest: SessionPackageManifest
  session: PersistedChatSession
  records: PackageRecords
}> => {
  const manifest = await readPackageArchive(path, directory, new AbortController().signal)
  return {
    manifest,
    session: await readSession(directory),
    records: parseNativeRecords(await readPackageJson(join(directory, 'records.json')))
  }
}

const repack = async (
  directory: string,
  archive: string,
  { session, records, manifest }: Awaited<ReturnType<typeof unpack>>,
  rewriteRecords = false
): Promise<void> => {
  await writeFile(join(directory, 'session.json'), JSON.stringify({ version: 2, session }))
  const replacements = new Map([
    ['session.json', await packageEntry(directory, 'session.json', 'session')]
  ])
  if (rewriteRecords) {
    await writeFile(join(directory, 'records.json'), JSON.stringify(records))
    replacements.set('records.json', await packageEntry(directory, 'records.json', 'records'))
  }
  manifest.inventory = manifest.inventory.map((entry) => replacements.get(entry.path) ?? entry)
  const signal = new AbortController().signal
  await writePackageRoCrateMetadata(directory, manifest, records, signal)
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
  await writePackageArchive(directory, archive, signal)
}

it('round-trips allowed Web bodies with independent IDs, no live grants, and preserves an imported local Fork', async () => {
  const source = await fixture(),
    target = await fixture()
  const repository = await storeSession(source)
  const original = await repository.loadSession('project-1', 'session-1')
  const exporter = service(source, true)
  const archive = join(source.storageRoot, 'allowed.science')
  await exporter.exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive)
  const exported = await unpack(archive, join(source.storageRoot, 'unpacked'))
  expect(exported.records.webEvidence?.snapshots[0].text).toBe(snapshot.text)
  expect(exported.records.webEvidence?.snapshots[0].sourceSha256).toBe(snapshot.sha256)
  expect(JSON.stringify(exported.session)).not.toContain('sender-private-cursor')
  expect(await repository.loadSession('project-1', 'session-1')).toEqual(original)
  initDataRoot(target.storageRoot)
  const importer = service(target, true)
  const imported = await importPackage(importer, archive)
  const local = (await new SessionRepository(target.storageRoot).loadSession(
    imported.projectId,
    imported.sessionId
  ))!
  const packet = local.activities![0].packageWebEvidence!
  expect(local.packageOrigin).toBeDefined()
  expect(packet.invocationId).not.toBe(snapshot.invocationId)
  expect(packet.document?.snapshotId).not.toBe(snapshot.snapshotId)
  expect(local.activities![0].executionInvocationId).toBe(packet.invocationId)
  expect(local.activities![0].webInvocation?.retryEligible).toBeUndefined()
  expect(local.activities![0].rawOutput).toBeUndefined()
  expect(JSON.stringify(local)).not.toContain('sender-private-cursor')
  const liveStore = new WebSnapshotStore(join(target.storageRoot, 'web-evidence'))
  for (const branchId of [
    undefined,
    ...local.conversationGraph!.branches.map((branch) => branch.id)
  ]) {
    const scope = webEvidenceScope(imported.projectId, imported.sessionId, branchId)
    expect(await liveStore.hasCommittedReference(scope, packet.document!.snapshotId!)).toBe(false)
    await expect(liveStore.readCommitted(scope, snapshot.snapshotId)).rejects.toMatchObject({
      code: 'INVALID_CURSOR'
    })
  }
  const forked = await importer.fork(imported)
  const fork = (await new SessionRepository(target.storageRoot).loadSession(
    forked.projectId,
    forked.sessionId
  ))!
  const forkPacket = fork.activities![0].packageWebEvidence!
  expect(forkPacket.document?.text).toBe(packet.document?.text)
  expect(forkPacket.invocationId).not.toBe(packet.invocationId)
  expect(forkPacket.invocationId).toBe(fork.activities![0].executionInvocationId)
  const forwarded = join(target.storageRoot, 'fork-forwarded.science')
  await importer.exportTo(forked, forwarded)
  const replay = await unpack(forwarded, join(target.storageRoot, 'forwarded'))
  expect(replay.records.webEvidence?.snapshots[0].text).toBe(snapshot.text)
  expect(replay.records.webEvidence?.snapshots[0].sourceSha256).toBe(snapshot.sha256)
  const origin = await importer.readOrigin(forked)
  expect(mapPackageReferences(origin.webEvidence, origin.identities)).toBeDefined()
})

it('reapplies current policy when forwarding and cannot bypass unknown policy with sensitive-content approval', async () => {
  const source = await fixture(),
    target = await fixture()
  await storeSession(source)
  const allowed = join(source.storageRoot, 'allowed.science')
  await service(source, true).exportTo({ projectId: 'project-1', sessionId: 'session-1' }, allowed)
  initDataRoot(target.storageRoot)
  const importer = service(target)
  const imported = await importPackage(importer, allowed)
  const denied = join(target.storageRoot, 'unknown.science')
  let summary: PackageSelectionSummary | undefined
  const result = await importer.exportTo(imported, denied, {
    allowSensitiveContent: true,
    selectFiles: async (_files, _signal, value) => {
      summary = value
      return []
    }
  })
  expect(summary?.webOmissions).toEqual(
    expect.arrayContaining([{ component: 'fetch_body', reason: 'policy-unknown', count: 1 }])
  )
  expect(result.webOmissions).toEqual(summary?.webOmissions)
  const exported = await unpack(denied, join(target.storageRoot, 'denied'))
  expect(exported.records.webEvidence?.snapshots).toEqual([])
  const bytes = JSON.stringify(exported)
  expect(bytes).not.toContain(snapshot.text)
  expect(bytes).not.toContain('Independent fetched article excerpt.')
  expect(bytes).not.toContain(snapshot.originalUrl)
  expect(bytes).not.toContain('sender-private-cursor')
})

it('keeps incomplete host Web records fail-closed while retaining legacy external details', async () => {
  const source = await fixture()
  const input = session()
  for (const item of [...input.activities!, ...input.conversationGraph!.activities])
    item.executionInvocationId = undefined
  const external: PersistedToolActivity = {
    ...activity(),
    id: 'external-tool',
    providerToolName: 'external/web_fetch',
    rawOutput: 'legacy external detail'
  }
  delete external.appOwned
  input.activities!.push(external)
  input.conversationGraph!.activities.push({
    ...input.conversationGraph!.activities[0],
    ...external
  })
  await storeSession(source, input)
  const archive = join(source.storageRoot, 'incomplete.science')
  const result = await service(source).exportTo(
    { projectId: 'project-1', sessionId: 'session-1' },
    archive,
    { allowSensitiveContent: true }
  )
  expect(result.webOmissions).toEqual(
    expect.arrayContaining([{ component: 'fetch_body', reason: 'invalid', count: 1 }])
  )
  const exported = await unpack(archive, join(source.storageRoot, 'incomplete'))
  const host = exported.session.conversationGraph!.activities.find((item) => item.appOwned)!
  expect(host.rawInput).toBeUndefined()
  expect(host.rawOutput).toBeUndefined()
  expect(host.toolContent).toBeUndefined()
  expect(
    exported.session.conversationGraph!.activities.find((item) => item.id === 'external-tool')
      ?.rawOutput
  ).toBe('legacy external detail')
  expect(exported.records.webEvidence?.omissions).toEqual(result.webOmissions)
})

it.each([
  ['search', 'Quartz specimen Q7'],
  ['fetch', 'Cobalt sample B4'],
  ['search', 'Quartz specimen Q7 was collected during the autumn field survey.'],
  ['fetch', 'Cobalt sample B4 was collected during the autumn field survey.']
] as const)(
  'projects inline %s copies of %s in the serialized Session and excludes only attributable attachments',
  async (operation, fragment) => {
    const source = await fixture()
    const input = session()
    const answer = `Observed ${fragment} during analysis.`
    const envelope = result()
    envelope.operation = operation
    if (operation === 'fetch') envelope.document!.text = fragment
    else {
      delete envelope.document
      envelope.provider = {
        id: 'exa',
        auth_mode: 'anonymous',
        data_policy_version: 'exa-anonymous-reviewed-2026-11-17'
      }
      envelope.request = { query: 'sample' }
      envelope.sources[0].snippet = fragment
      envelope.sources[0].evidence_kind = 'provider_excerpt'
    }
    for (const row of [...input.activities!, ...input.conversationGraph!.activities]) {
      row.providerToolName = `mcp__open_science_web__web_${operation}`
      row.rawInput = envelope.request
      row.rawOutput = envelope
      row.toolContent = [
        { type: 'content', content: { type: 'text', text: JSON.stringify(envelope) } }
      ]
    }
    for (const activities of [input.activities!, input.conversationGraph!.activities]) {
      const external = {
        ...activities[0],
        title: 'External tool',
        webInvocation: undefined,
        id: 'other-tool',
        providerToolName: 'other/tool',
        executionInvocationId: 'other-invocation',
        appOwned: undefined,
        rawInput: { query: 'keep me' },
        rawOutput: {
          stdout: answer,
          invocationId: snapshot.invocationId,
          label: 'independent output'
        },
        toolContent: [
          { type: 'content' as const, content: { type: 'text' as const, text: answer } }
        ]
      }
      activities.push(external)
    }
    for (const message of [...input.messages, ...input.conversationGraph!.messages])
      if (message.role === 'agent') message.content = answer
    const repository = await storeSession(source, input)
    const before = await repository.loadSession(input.projectId, input.id)
    const unrelated = 'The specimen and sample remain in storage.'
    for (const [filename, content] of [
      ['copy.txt', answer],
      ['unrelated.txt', unrelated]
    ]) {
      await source.compatibilityRepository.writePendingFile({
        projectId: input.projectId,
        sessionId: 'artifact-session-1',
        runId: 'artifact-run-1',
        filename,
        mimeType: 'text/plain',
        source: { kind: 'inline', content, encoding: 'utf8' }
      })
      await source.repository.createVersion(
        createArtifactVersionRequest({
          filename,
          contentType: 'text/plain',
          writeOperationId: filename
        })
      )
    }
    const versions = await source.client.artifactVersion.findMany()
    const exporter = createService(source, { resolvePolicy: resolveReviewedWebPolicy })
    const archive = join(source.storageRoot, 'short.science'),
      directory = join(source.storageRoot, 'unpacked-short')
    await exporter.exportTo({ projectId: input.projectId, sessionId: input.id }, archive, {
      allowSensitiveContent: true
    })
    const exported = await unpack(archive, directory)
    expect(JSON.stringify(exported.session)).not.toContain(fragment)
    expect(exported.session.messages.find((m) => m.role === 'agent')?.content).toBe(
      'Observed  during analysis.'
    )
    for (const activities of [
      exported.session.activities!,
      exported.session.conversationGraph!.activities
    ]) {
      expect(activities.find((activity) => activity.id === 'other-tool')).toMatchObject({
        providerToolName: 'other/tool',
        rawInput: { query: 'keep me' },
        rawOutput: {
          stdout: 'Observed  during analysis.',
          invocationId: snapshot.invocationId,
          label: 'independent output'
        },
        toolContent: [
          { type: 'content', content: { type: 'text', text: 'Observed  during analysis.' } }
        ]
      })
    }
    expect(exported.records.webEvidence!.activities[0].sources[0]).toMatchObject({
      title: articleTitle,
      url: snapshot.finalUrl
    })
    expect(JSON.stringify(exported.records)).not.toContain(fragment)
    expect(exported.manifest.excludedFiles.map((file) => file.filename)).toEqual(['copy.txt'])
    const retained = versions.find((v) => v.filename === 'unrelated.txt')!
    const entry = exported.manifest.inventory.find(
      (e) => e.storageKey === retained.contentStorageKey
    )!
    expect(await readFile(join(directory, entry.path), 'utf8')).toBe(unrelated)
    expect(await repository.loadSession(input.projectId, input.id)).toEqual(before)
    expect(await source.client.artifactVersion.findMany()).toEqual(versions)
  }
)

it('automatically omits optional attachment copies of Web receipts even with sensitive approval', async () => {
  const source = await fixture()
  await storeSession(source)
  const copies = [
    ['receipt.png', JSON.stringify({ receipt: result() })],
    [
      'large-request.png',
      JSON.stringify({
        invocationId: snapshot.invocationId,
        padding: 'x'.repeat(200000),
        rawInput: { url: snapshot.originalUrl }
      })
    ],
    [
      'escaped-title.png',
      JSON.stringify({
        invocationId: snapshot.invocationId,
        padding: 'x'.repeat(200000),
        rawInput: { title: articleTitle }
      })
    ],
    [
      'unrelated.png',
      JSON.stringify({
        padding: 'x'.repeat(200000),
        rawInput: { title: articleTitle, url: snapshot.originalUrl }
      })
    ]
  ]
  for (const [filename, contents] of copies) {
    await addPngVersion(source, filename, contents, `write-${filename}`)
  }
  const archive = join(source.storageRoot, 'attachment.science')
  const exportedPreview = await service(source).exportTo(
    { projectId: 'project-1', sessionId: 'session-1' },
    archive,
    { allowSensitiveContent: true }
  )
  const exported = await unpack(archive, join(source.storageRoot, 'attachment'))
  expect(exported.manifest.excludedFiles.map((file) => file.filename).sort()).toEqual([
    'escaped-title.png',
    'large-request.png',
    'receipt.png'
  ])
  expect(exportedPreview.webOmissions).toEqual(
    expect.arrayContaining([{ component: 'fetch_body', reason: 'redacted', count: 3 }])
  )
  expect(
    exported.manifest.inventory.every((entry) => !entry.storageKey?.includes('receipt.png'))
  ).toBe(true)
})

it('blocks required derived checkpoint bytes without weakening scientific hashes or blocking local Fork', async () => {
  const source = await fixture()
  await storeSession(source)
  const directory = join(source.storageRoot, 'notebooks', 'project-1', 'session-1', 'data')
  await mkdir(directory, { recursive: true })
  const checkpoint = join(directory, 'checkpoint.json')
  const bytes = JSON.stringify({ checkpoint: { receipt: result() } })
  await writeFile(checkpoint, bytes)
  const exporter = service(source)
  await expect(
    exporter.exportTo(
      { projectId: 'project-1', sessionId: 'session-1' },
      join(source.storageRoot, 'restricted.science'),
      { allowSensitiveContent: true }
    )
  ).rejects.toMatchObject({ code: 'WEB_PACKAGE_POLICY_RESTRICTED' })
  expect(await readFile(checkpoint, 'utf8')).toBe(bytes)
  const forked = await exporter.fork({ projectId: 'project-1', sessionId: 'session-1' })
  expect(
    await new SessionRepository(source.storageRoot).loadSession(forked.projectId, forked.sessionId)
  ).toBeDefined()
  expect(await readFile(checkpoint, 'utf8')).toBe(bytes)
})

it('omits a failed Web request copied far from its execution ID without fabricating successful evidence', async () => {
  const source = await fixture()
  const input = session()
  for (const item of [...input.activities!, ...input.conversationGraph!.activities]) {
    item.status = 'failed'
    item.rawOutput = { message: 'Network unavailable' }
    item.toolContent = undefined
  }
  await storeSession(source, input)
  await addPngVersion(
    source,
    'failed-request.png',
    JSON.stringify({
      invocationId: snapshot.invocationId,
      padding: 'x'.repeat(200000),
      rawInput: { url: snapshot.originalUrl }
    })
  )
  const archive = join(source.storageRoot, 'failed-request.science')
  await service(source).exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive, {
    allowSensitiveContent: true
  })
  const exported = await unpack(archive, join(source.storageRoot, 'failed-request'))
  expect(exported.manifest.excludedFiles.map((file) => file.filename)).toEqual([
    'failed-request.png'
  ])
  expect(exported.records.webEvidence?.activities[0].status).toBe('unavailable')
  expect(exported.records.webEvidence?.snapshots).toEqual([])
})

it('does not forward records-only Web bodies after their Session activities have been removed', async () => {
  const source = await fixture(),
    target = await fixture()
  await storeSession(source)
  const allowed = join(source.storageRoot, 'allowed.science')
  await service(source, true).exportTo({ projectId: 'project-1', sessionId: 'session-1' }, allowed)
  const directory = join(source.storageRoot, 'orphaned')
  const altered = await unpack(allowed, directory)
  altered.session.activities = []
  altered.session.conversationGraph!.activities = []
  const archive = join(source.storageRoot, 'records-only.science')
  await repack(directory, archive, altered)
  initDataRoot(target.storageRoot)
  const importer = service(target)
  const imported = await importPackage(importer, archive)
  const forwarded = join(target.storageRoot, 'filtered.science')
  await importer.exportTo(imported, forwarded, { allowSensitiveContent: true })
  const exported = await unpack(forwarded, join(target.storageRoot, 'filtered'))
  expect(exported.records.webEvidence?.snapshots ?? []).toEqual([])
  expect(JSON.stringify(exported.records)).not.toContain(snapshot.text)
  expect(exported.records.webEvidence?.omissions.some((item) => item.reason === 'invalid')).toBe(
    true
  )
})

it('omits a long exact restricted body prefix across stream chunks even without its execution ID', async () => {
  const source = await fixture(),
    target = await fixture()
  const fullBody = '\u0001'.repeat(16 * 1024 - 1) + '😀' + 'protected full body '.repeat(12000)
  const longSnapshot = { ...snapshot, text: fullBody, sha256: webTextHash(fullBody) }
  const input = session()
  const envelope = result()
  envelope.document!.sha256 = longSnapshot.sha256
  for (const item of [...input.activities!, ...input.conversationGraph!.activities]) {
    item.rawOutput = envelope
    item.toolContent = [
      { type: 'content', content: { type: 'text', text: JSON.stringify(envelope) } }
    ]
  }
  await storeSession(source, input)
  // The 16 KiB protected prefix serializes to 96 KiB. Starting near the first 64 KiB
  // boundary forces it across three reads; no one 64 KiB overlap contains it whole.
  for (const [filename, invocation] of [
    ['body-copy.png', snapshot.invocationId],
    ['unrelated-body.png', 'unrelated-execution']
  ]) {
    await addPngVersion(
      source,
      filename,
      JSON.stringify({ invocationId: invocation, padding: 'x'.repeat(63 * 1024), body: fullBody }),
      `write-${filename}`
    )
  }
  const allowed = join(source.storageRoot, 'allowed-long-body.science')
  await service(source, true, longSnapshot).exportTo(
    { projectId: 'project-1', sessionId: 'session-1' },
    allowed
  )
  const directory = join(source.storageRoot, 'long-body-records')
  const altered = await unpack(allowed, directory)
  altered.session.activities = []
  altered.session.conversationGraph!.activities = []
  // Keep the valid, hash-sealed full body while removing the optional small excerpt,
  // so the scanner must recognize the long full-body pattern rather than that excerpt.
  const document = altered.records.webEvidence!.activities[0].document!
  delete document.text
  delete document.projectedSha256
  const archive = join(source.storageRoot, 'long-body-copy.science')
  await repack(directory, archive, altered, true)
  initDataRoot(target.storageRoot)
  const importer = service(target)
  const imported = await importPackage(importer, archive)
  const forwarded = join(target.storageRoot, 'long-body-filtered.science')
  await importer.exportTo(imported, forwarded, { allowSensitiveContent: true })
  const exported = await unpack(forwarded, join(target.storageRoot, 'long-body-filtered'))
  expect(exported.manifest.excludedFiles.map((file) => file.filename).sort()).toEqual([
    'body-copy.png',
    'unrelated-body.png'
  ])
  const unrelated = exported.records.tables.ArtifactVersion.find(
    (row) => row.filename === 'unrelated-body.png'
  )!
  expect(
    exported.manifest.inventory.some((entry) => entry.storageKey === unrelated.contentStorageKey)
  ).toBe(false)
})

it('round-trips Exa attribution through a package and read-only fork without excerpts', async () => {
  const source = await fixture(),
    target = await fixture()
  const input = session()
  const provider = {
    id: 'exa',
    auth_mode: 'anonymous' as const,
    data_policy_version: 'exa-anonymous-reviewed-2026-11-17'
  }
  const search: WebResult = {
    schema: 'open-science.web.v2',
    operation: 'search',
    invocation_id: 'host-search',
    status: 'ok',
    request: { query: 'public science' },
    retrieved_at: now,
    duration_ms: 5,
    provider,
    attempts: [
      {
        index: 1,
        provider,
        execution: 'direct_search',
        started_at: now,
        duration_ms: 5,
        status: 'ok',
        search_executed: true
      }
    ],
    sources: [
      {
        source_id: 'exa-source',
        url: 'https://example.org/article',
        title: 'Citation',
        published_at: '2026-11-17T08:00:00+08:00',
        snippet: 'Provider excerpt excluded from portable research evidence.',
        evidence_kind: 'provider_excerpt',
        attempt_index: 1
      }
    ],
    returned_count: 1
  }
  for (const row of [...input.activities!, ...input.conversationGraph!.activities])
    Object.assign(row, {
      executionInvocationId: search.invocation_id,
      providerToolName: 'mcp__open_science_web__web_search',
      rawInput: search.request,
      rawOutput: search,
      toolContent: [{ type: 'content', content: { type: 'text', text: JSON.stringify(search) } }]
    })
  await storeSession(source, input)
  const exporter = createService(source, { resolvePolicy: resolveReviewedWebPolicy })
  const archive = join(source.storageRoot, 'exa.science')
  await exporter.exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive)
  initDataRoot(target.storageRoot)
  const inspected = await unpack(archive, join(source.storageRoot, 'exa-inspected'))
  expect(inspected.manifest.requiredFeatures).toContain('web-evidence-v2')
  await expect(
    validatePackageRecords(
      join(source.storageRoot, 'exa-inspected'),
      {
        ...inspected.manifest,
        requiredFeatures: inspected.manifest.requiredFeatures!.filter(
          (feature) => feature !== 'web-evidence-v2'
        )
      },
      inspected.records
    )
  ).rejects.toThrow(/reader capability/)
  await expect(
    validatePackageRecords(join(source.storageRoot, 'exa-inspected'), inspected.manifest, {
      ...inspected.records,
      webEvidence: undefined
    })
  ).rejects.toThrow(/reader capability/)
  const importer = service(target, true)
  const imported = await importPackage(importer, archive)
  const forked = await importer.fork(imported)
  const fork = (await new SessionRepository(target.storageRoot).loadSession(
    forked.projectId,
    forked.sessionId
  ))!
  const packet = fork.activities![0].packageWebEvidence!
  expect(packet.sources[0]).toMatchObject({
    evidenceKind: 'provider_excerpt',
    attemptIndex: 1,
    publishedAt: '2026-11-17T08:00:00+08:00'
  })
  expect(packet.sources[0].sourceId).not.toBe('exa-source')
  expect(packet.sources[0].snippet).toBeUndefined()
  expect(packet.attempts![0]).toMatchObject({ provider, execution: 'direct_search' })
  expect(fork.forkOrigin).toBeDefined()
  await new SessionRepository(target.storageRoot).deleteSession(
    imported.projectId,
    imported.sessionId
  )
  const offlineChild = await new SessionRepository(target.storageRoot).loadSession(
    forked.projectId,
    forked.sessionId
  )
  expect(offlineChild!.activities![0].packageWebEvidence).toEqual(packet)
  expect(fork.activities![0].webInvocation?.retryEligible).toBeUndefined()
  expect(JSON.stringify(fork)).not.toContain('Provider excerpt excluded')
})
