import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zipSync, gzipSync } from 'fflate'
import { x as extractTar } from 'tar'
import { expect, it, vi } from 'vitest'
import { createProvenanceTestFixture } from '../artifacts/provenance-test-fixtures'
import { SessionRepository } from '../session-persistence/repository'
import { initDataRoot } from '../storage-root'
import { SessionPackageService } from './service'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false }
}))

it('handles cancellation during export validation before reaching later sensitive content', async () => {
  const fixture = await createProvenanceTestFixture()
  initDataRoot(fixture.storageRoot)
  const service = new SessionPackageService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
  let cancellation: NodeJS.Immediate | undefined
  try {
    await fixture.client.project.create({ data: { id: 'project-1', name: 'Research' } })
    const sessions = new SessionRepository(fixture.storageRoot)
    await sessions.saveSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Research',
      cwd: '',
      status: 'idle',
      createdAt: 1,
      updatedAt: 2,
      messages: Array.from({ length: 32 }, (_, index) => ({
        id: `message-${index}`,
        role: 'user',
        content:
          index === 31
            ? 'Authorization: Bearer synthetic-private-value'
            : 'Research evidence. '.repeat(512),
        status: 'complete',
        eventIds: [],
        createdAt: index,
        updatedAt: index
      }))
    })
    const request = { projectId: 'project-1', sessionId: 'session-1' }
    const before = await sessions.loadSession(request.projectId, request.sessionId)
    const destination = join(fixture.storageRoot, 'research.science')
    await writeFile(destination, 'previous export')
    const controller = new AbortController()
    const reason = new Error('Cancel requested during validation')
    await expect(
      service.exportTo(request, destination, {
        signal: controller.signal,
        selectFiles: async () => {
          // The next event-loop turn represents a Cancel event arriving from the UI.
          // A synchronous scan reaches the final credential before this can run.
          cancellation = setImmediate(() => controller.abort(reason))
          return []
        }
      })
    ).rejects.toBe(reason)
    expect(await readFile(destination, 'utf8')).toBe('previous export')
    expect(await sessions.loadSession(request.projectId, request.sessionId)).toEqual(before)

    // Cancellation must release the operation owner; a retry still checks the entire history.
    await expect(service.exportTo(request, destination)).rejects.toThrow(
      'Sensitive content detected'
    )
    expect(await readFile(destination, 'utf8')).toBe('previous export')
  } finally {
    if (cancellation) clearImmediate(cancellation)
    await service.close()
    await fixture.dispose()
    initDataRoot(undefined)
  }
})

it.each([
  [
    'token count crossing a chunk boundary',
    Buffer.from(' '.repeat(65514) + '{"estimatedTokens":71862,"tokens":88197}'),
    true
  ],
  [
    'cache count crossing a chunk boundary',
    Buffer.from(
      ' '.repeat(65519) + '{"cacheTokens":123456,"cachedReadTokens":123456,"cachedWriteTokens":0}'
    ),
    true
  ],
  [
    'credential after a token count',
    Buffer.from('{"estimatedTokens":71862,"password":"synthetic-private-value"}'),
    false
  ],
  [
    'binary ZIP bytes under an extensionless evidence name',
    Buffer.from(zipSync({ 'token=measurements.csv': Buffer.from('year,flights\n2026,300\n') })),
    true
  ],
  ['long quoted CLI credential', Buffer.from('--password "' + 'a'.repeat(70000) + '"'), false],
  [
    'escaped placeholder across chunks',
    Buffer.from('x'.repeat(65510) + '\npassword="\\u005bredacted]"'),
    true
  ],
  [
    'encoded URL placeholder across chunks',
    Buffer.from('x'.repeat(65495) + '\nhttps://example.org/?token=%5Bredacted%5D'),
    true
  ],
  ['long credential', Buffer.from('password=' + 'a'.repeat(70000)), false],
  ['long URL credential', Buffer.from('https://example.org/?token=' + 'a'.repeat(70000)), false],
  ['long quoted credential', Buffer.from(JSON.stringify({ password: 'a'.repeat(70000) })), false],
  ['gzip data', Buffer.from(gzipSync(Buffer.from('year,flights\n2026,300\n'))), true],
  [
    'Office ZIP container',
    Buffer.from(
      zipSync({ 'word/document.xml': Buffer.from('<document>token=measurements</document>') })
    ),
    true
  ],
  [
    'ASCII PDF container',
    Buffer.from('%PDF-1.7\n1 0 obj << /Title (token=measurements) >> endobj\n%%EOF'),
    true
  ],
  [
    'PNG binary bytes',
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from('token=measurements')
    ]),
    true
  ],
  [
    'HDF binary bytes',
    Buffer.concat([
      Buffer.from([137, 72, 68, 70, 13, 10, 26, 10]),
      Buffer.from('token=measurements')
    ]),
    true
  ],
  [
    'UTF-16LE text credentials',
    Buffer.concat([
      Buffer.from([255, 254]),
      Buffer.from('password=synthetic-private-value', 'utf16le')
    ]),
    false
  ],
  [
    'UTF-16BE text credentials',
    Buffer.concat([
      Buffer.from([254, 255]),
      Buffer.from('password=synthetic-private-value', 'utf16le').swap16()
    ]),
    false
  ],
  [
    'UTF-16LE safe text',
    Buffer.concat([
      Buffer.from([255, 254]),
      Buffer.from('password=""\nAuthorization: Bearer [redacted]', 'utf16le')
    ]),
    true
  ],
  ['UTF-8 BOM and safe values', Buffer.from('\ufeff{"password":"","token":"[redacted]"}'), true],
  [
    'redaction marker split across reads',
    Buffer.from('a'.repeat(65510) + '\nAuthorization: Bearer [redacted]'),
    true
  ],
  [
    'empty URL parameter split across reads',
    Buffer.from('a'.repeat(65510) + '\nhttps://example.org/?token='),
    true
  ],
  [
    'safe JSON long line',
    Buffer.from(JSON.stringify({ notes: 'a'.repeat(150000), password: '', token: '[redacted]' })),
    true
  ],
  [
    'binary content after a text-like prefix',
    Buffer.concat([
      Buffer.from('Authorization: Bearer synthetic-private-value\n'),
      Buffer.alloc(70 * 1024, 65),
      Buffer.from([0xff])
    ]),
    true
  ],
  [
    'NUL-bearing binary data',
    Buffer.from('binary\0Authorization: Bearer synthetic-private-value'),
    true
  ],
  [
    'incomplete UTF-8 at EOF',
    Buffer.concat([
      Buffer.from('Authorization: Bearer synthetic-private-value'),
      Buffer.from([0xe7])
    ]),
    true
  ],
  [
    'credentials crossing a chunk boundary',
    Buffer.from('a'.repeat(65530) + '\nAuthorization: Bearer synthetic-private-value'),
    false
  ],
  [
    'extensionless UTF-8 credentials',
    Buffer.from('Authorization: Bearer synthetic-private-value'),
    false
  ],
  [
    'text disguised with a ZIP extension',
    Buffer.from('Authorization: Bearer synthetic-private-value'),
    false
  ],
  [
    'UTF-8 text crossing a chunk boundary',
    Buffer.from('a'.repeat(65535) + '研究\nplain results'),
    true
  ]
])('classifies %s before applying text credential checks', async (label, bytes, allowed) => {
  const fixture = await createProvenanceTestFixture()
  initDataRoot(fixture.storageRoot)
  const service = new SessionPackageService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
  try {
    await fixture.client.project.create({ data: { id: 'project-1', name: 'Research' } })
    await new SessionRepository(fixture.storageRoot).saveSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Research',
      cwd: '',
      status: 'idle',
      createdAt: 1,
      updatedAt: 2,
      messages: []
    })
    const directory = join(fixture.storageRoot, 'notebooks', 'project-1', 'session-1', 'data')
    await mkdir(directory, { recursive: true })
    const source = join(
      directory,
      label === 'text disguised with a ZIP extension' ? 'data.zip' : 'content'
    )
    await writeFile(source, bytes)
    const destination = join(fixture.storageRoot, 'result.science')
    const pending = service.exportTo(
      { projectId: 'project-1', sessionId: 'session-1' },
      destination
    )
    if (allowed) {
      await expect(pending).resolves.toBeDefined()
      const imported = await service.importFrom(destination)
      await expect(
        service.exportTo(imported, join(fixture.storageRoot, 'forwarded.science'))
      ).resolves.toBeDefined()
    } else await expect(pending).rejects.toThrow('Sensitive content detected')
    expect(await readFile(source)).toEqual(bytes)
  } finally {
    await service.close()
    await fixture.dispose()
    initDataRoot(undefined)
  }
})

it('honors cancellation after a text match while classifying the remaining file', async () => {
  const pacing = await import('../file-io-pacing')
  const originalPace = pacing.paceFileIo
  const fixture = await createProvenanceTestFixture()
  initDataRoot(fixture.storageRoot)
  const service = new SessionPackageService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
  const controller = new AbortController()
  const reason = new Error('Cancel classification')
  let copied = false
  let scanChunks = 0
  const spy = vi.spyOn(pacing, 'paceFileIo').mockImplementation(async (bytes, signal) => {
    if (copied && ++scanChunks === 2) controller.abort(reason)
    await originalPace(bytes, signal)
  })
  try {
    await fixture.client.project.create({ data: { id: 'project-1', name: 'Research' } })
    await new SessionRepository(fixture.storageRoot).saveSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Research',
      cwd: '',
      status: 'idle',
      createdAt: 1,
      updatedAt: 2,
      messages: []
    })
    const directory = join(fixture.storageRoot, 'notebooks', 'project-1', 'session-1', 'data')
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'content'),
      'password=synthetic-private-value\n' + 'a'.repeat(150000)
    )
    const destination = join(fixture.storageRoot, 'result.science')
    await writeFile(destination, 'previous export')
    await expect(
      service.exportTo({ projectId: 'project-1', sessionId: 'session-1' }, destination, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.phase === 'copying' && progress.completedBytes === progress.totalBytes)
            copied = true
        }
      })
    ).rejects.toBe(reason)
    expect(scanChunks).toBe(2)
    expect(await readFile(destination, 'utf8')).toBe('previous export')
  } finally {
    spy.mockRestore()
    await service.close()
    await fixture.dispose()
    initDataRoot(undefined)
  }
})

it('preserves context and model-step token counts through native export and imported-package forwarding', async () => {
  const fixture = await createProvenanceTestFixture()
  initDataRoot(fixture.storageRoot)
  const sessions = new SessionRepository(fixture.storageRoot)
  const service = new SessionPackageService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
  const contextWindow = {
    used: 88197,
    size: 1000000,
    breakdown: {
      source: 'estimated' as const,
      tokenizer: 'cl100k_base' as const,
      model: 'MiniMax-M3',
      estimatedTokens: 71862,
      difference: 16335,
      status: 'reconciled' as const,
      categories: [
        { key: 'system' as const, tokens: 71862, estimated: true },
        { key: 'other' as const, tokens: 16335, estimated: true }
      ]
    }
  }
  const modelStepUsage = {
    inputTokens: 351,
    cacheTokens: 123456,
    cachedReadTokens: 123456,
    cachedWriteTokens: 0,
    outputTokens: 890
  }
  try {
    await fixture.client.project.create({ data: { id: 'project-1', name: 'Research' } })
    await sessions.saveSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Context counts',
      cwd: '',
      status: 'idle',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Research',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 2,
          contextWindowSamples: [
            {
              id: 'sample-1',
              timestamp: 2,
              termination: { kind: 'stop', stopReason: 'end_turn' },
              source: 'provider-response',
              contextWindow,
              modelStepUsage
            }
          ]
        }
      ]
    })
    const request = { projectId: 'project-1', sessionId: 'session-1' }
    const before = await sessions.loadSession(request.projectId, request.sessionId)
    expect(before?.messages[0].contextWindowSamples?.[0].contextWindow).toEqual(contextWindow)
    expect(before?.messages[0].contextWindowSamples?.[0].modelStepUsage).toEqual(modelStepUsage)
    const native = join(fixture.storageRoot, 'native.science')
    await service.exportTo(request, native)
    const imported = await service.importFrom(native)
    const forwarded = join(fixture.storageRoot, 'forwarded.science')
    await service.exportTo(imported, forwarded)
    const documents: string[] = []
    for (const [index, archive] of [native, forwarded].entries()) {
      const directory = join(fixture.storageRoot, `expanded-${index}`)
      await mkdir(directory)
      await extractTar({ file: archive, cwd: directory })
      const document = await readFile(join(directory, 'session.json'), 'utf8')
      expect(
        JSON.parse(document).session.messages[0].contextWindowSamples[0].contextWindow
      ).toEqual(contextWindow)
      expect(
        JSON.parse(document).session.messages[0].contextWindowSamples[0].modelStepUsage
      ).toEqual(modelStepUsage)
      documents.push(document)
    }
    expect(documents[1]).toBe(documents[0])
    expect(await sessions.loadSession(request.projectId, request.sessionId)).toEqual(before)
  } finally {
    await service.close()
    await fixture.dispose()
    initDataRoot(undefined)
  }
})
