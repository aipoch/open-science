import { describe, expect, it, vi } from 'vitest'
import type { RunObservationSnapshot } from '../../shared/run-observation'
import { appendViewerChanges, ReplayViewerClient } from './client'
import { selectionReference } from './selection-reference'
const record = (sequence = 1): RunObservationSnapshot => ({
  identity: { projectId: 'p', sessionId: 's', operationId: 'op', runId: 'run' },
  cursor: { epoch: 'epoch', sequence },
  observedAt: sequence + 1000,
  phase: 'running',
  stepId: 'run:run',
  run: {
    runId: 'run',
    kernelKind: 'bash',
    status: 'running',
    startedAt: 1000,
    logs: {
      stdout: { text: `line ${sequence}`, truncated: false, redacted: false },
      stderr: { text: '', truncated: false, redacted: false },
      traceback: { text: '', truncated: false, redacted: false }
    }
  },
  artifacts: [],
  artifactsTruncated: false
})
const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
describe('scoped browser viewer transport', () => {
  it.each(['live', 'recorded'] as const)(
    'uses validated desktop language before painting %s Replay without overriding browser preferences',
    async (mode) => {
      const context = {
        mode,
        viewerId: 'viewer',
        expiresAt: 10000,
        target:
          mode === 'recorded'
            ? { projectId: 'p', sessionId: 's', artifactId: 'a', versionId: 'v' }
            : { projectId: 'p', sessionId: 's', runId: 'run' },
        presentation: 'desktop',
        locale: 'zh-Hans',
        canInteract: false,
        canCancel: false,
        canReadArtifacts: true
      }
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(context))
      const client = new ReplayViewerClient(fetcher)
      expect(await client.initialLocale('en')).toBe('zh-Hans')
      fetcher.mockResolvedValueOnce(json({ ...context, presentation: 'browser' }))
      expect(await client.initialLocale('de')).toBe('de')
      fetcher.mockResolvedValueOnce(json({ ...context, locale: 'unsupported' }))
      expect(await client.initialLocale('en')).toBe('en')
      fetcher.mockRejectedValueOnce(new Error('Offline'))
      expect(await client.initialLocale('ja')).toBe('ja')
    }
  )

  it('requests only its bound archive and validates the exact receiving Version and bootstrap destination', async () => {
    const target = { projectId: 'p', sessionId: 's', artifactId: 'a', versionId: 'v' }
    const access = {
      mode: 'recorded',
      viewerId: 'archive-viewer',
      target,
      expiresAt: 10000,
      url: `http://viewer-archive-viewer.localhost:12345/__open_science_viewer?grant=${'a'.repeat(64)}`
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(access))
    const client = new ReplayViewerClient(fetcher)
    expect(await client.openArchive(target)).toEqual(access)
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      '/api/open-archive',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        body: '{}'
      })
    )
    fetcher.mockResolvedValueOnce(json({ ...access, target: { ...target, versionId: 'other' } }))
    await expect(client.openArchive(target)).rejects.toMatchObject({ kind: 'invalid-response' })
    fetcher.mockResolvedValueOnce(json({ ...access, url: 'http://localhost:12345/' }))
    await expect(client.openArchive(target)).rejects.toMatchObject({ kind: 'invalid-response' })
  })

  it('only sends a cursor and step to the fixed same-origin endpoint, with no management token or target scope', async () => {
    const snapshot = record()
    const selection = {
      selectionId: 'selected',
      identity: snapshot.identity,
      cursor: snapshot.cursor,
      stepId: snapshot.stepId,
      selectedAt: 2000,
      snapshot
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(selection))
    const client = new ReplayViewerClient(fetcher)
    expect(await client.select(snapshot)).toEqual(selection)
    expect(fetcher).toHaveBeenCalledWith(
      '/api/select',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        body: JSON.stringify({ cursor: snapshot.cursor, stepId: snapshot.stepId }),
        headers: { 'Content-Type': 'application/json' }
      })
    )
    const reference = selectionReference('viewer', selection)
    expect(JSON.parse(reference)).toMatchObject({
      viewerId: 'viewer',
      selectionId: 'selected',
      runId: 'run'
    })
    expect(reference).not.toContain('grant')
  })
  it('rejects a selection from a later cursor instead of silently changing the requested evidence', async () => {
    const snapshot = record()
    const wrong = record(2)
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        selectionId: 'selected',
        identity: wrong.identity,
        cursor: wrong.cursor,
        stepId: wrong.stepId,
        selectedAt: 2000,
        snapshot: wrong
      })
    )
    await expect(new ReplayViewerClient(fetcher).select(snapshot)).rejects.toMatchObject({
      kind: 'invalid-response'
    })
  })
  it('rejects altered evidence even when the server repeats the requested cursor', async () => {
    const snapshot = record(),
      altered = record()
    const replacement = {
      ...altered,
      run: {
        ...altered.run!,
        logs: {
          ...altered.run!.logs,
          stdout: { text: 'later unselected output', truncated: false, redacted: false }
        }
      }
    }
    const client = new ReplayViewerClient(
      vi.fn<typeof fetch>().mockResolvedValue(
        json({
          selectionId: 'selected',
          identity: snapshot.identity,
          cursor: snapshot.cursor,
          stepId: snapshot.stepId,
          selectedAt: 2000,
          snapshot: replacement
        })
      )
    )
    await expect(client.select(snapshot)).rejects.toMatchObject({ kind: 'invalid-response' })
  })
  it('rebuilds all real intermediate records and treats repeated deltas idempotently', () => {
    const one = record(1),
      two = record(2),
      three = record(3)
    const history = { coverage: 'process-local' as const, truncated: false, snapshots: [one] }
    const update = {
      kind: 'delta' as const,
      from: one.cursor,
      cursor: three.cursor,
      changes: [two, three]
    }
    const next = appendViewerChanges(history, update)
    expect(next.snapshots.map((s) => s.cursor.sequence)).toEqual([1, 2, 3])
    expect(appendViewerChanges(next, update)).toEqual(next)
  })
  it('accepts a verified purpose delta and preserves it through live observation projection', async () => {
    const one = record(1),
      two = record(2)
    const executionContext = {
      purpose: 'research' as const,
      profileName: 'Recipient configuration',
      conditionChanges: ['Smaller sample']
    }
    const delta = {
      kind: 'delta',
      from: one.cursor,
      cursor: two.cursor,
      changes: [{ cursor: two.cursor, observedAt: two.observedAt, executionContext }]
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(delta))
    const client = new ReplayViewerClient(fetcher)
    const update = await client.changes(one)
    const history = appendViewerChanges(
      { coverage: 'process-local', truncated: false, snapshots: [one] },
      update
    )
    expect(history.snapshots.at(-1)?.executionContext).toEqual(executionContext)
    fetcher.mockResolvedValueOnce(
      json({
        ...delta,
        changes: [
          { ...delta.changes[0], executionContext: { ...executionContext, secret: 'forbidden' } }
        ]
      })
    )
    await expect(client.changes(one)).rejects.toMatchObject({ kind: 'invalid-response' })
  })
  it('rejects cursor gaps, and epoch replacement discloses a new limited observation window', () => {
    const one = record(),
      three = record(3)
    const history = { coverage: 'process-local' as const, truncated: false, snapshots: [one] }
    expect(() =>
      appendViewerChanges(history, {
        kind: 'delta',
        from: one.cursor,
        cursor: three.cursor,
        changes: [three]
      })
    ).toThrow()
    const restarted = { ...record(0), cursor: { epoch: 'new-epoch', sequence: 0 } }
    expect(
      appendViewerChanges(history, { kind: 'resync', reason: 'epoch-changed', snapshot: restarted })
    ).toEqual({ coverage: 'process-local', truncated: true, snapshots: [restarted] })
  })
  it('only accepts a one-use project page on the matching isolated view hostname and exact run', async () => {
    const view = {
      viewId: 'view-1',
      scope: {
        projectId: 'p',
        sessionId: 's',
        runId: 'run',
        environmentId: 'env',
        generationId: 'generation'
      },
      title: 'Project',
      state: 'ready',
      createdAt: '2026-10-06T00:00:00Z',
      expiresAt: '2026-10-06T01:00:00Z',
      embeddingAdapted: true
    }
    const url = `http://rv-view-1.localhost:12345/__open_science_view?grant=${'a'.repeat(64)}`
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ view, url }))
      .mockResolvedValueOnce(json({ view, url: 'https://example.com/' }))
      .mockResolvedValueOnce(
        json({ view: { ...view, scope: { ...view.scope, runId: 'other' } }, url })
      )
    const client = new ReplayViewerClient(fetcher)
    expect((await client.projectView(record())).url).toBe(url)
    await expect(client.projectView(record())).rejects.toMatchObject({ kind: 'invalid-response' })
    await expect(client.projectView(record())).rejects.toMatchObject({ kind: 'invalid-response' })
    expect(fetcher.mock.calls.every(([path]) => path === '/api/project-view')).toBe(true)
    expect(fetcher.mock.calls[0][1]?.body).toBe('{}')
  })
  it('does not expose raw authorization diagnostics or retry a rejected mutation', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ error: { message: 'private token details' } }, 403))
    await expect(new ReplayViewerClient(fetcher).cancel()).rejects.toMatchObject({
      kind: 'authorization',
      status: 403
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][1]?.body).toBe('{"confirmed":true}')
  })
  it('reads one exact Version and bounds text without executing or interpreting its content', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('x'.repeat(200 * 1024), { headers: { 'content-type': 'text/plain' } })
      )
    const result = await new ReplayViewerClient(fetcher).readResource({
      id: 'v',
      name: 'result.txt',
      projectId: 'p',
      sessionId: 's',
      versionId: 'v',
      availability: 'recorded'
    })
    expect(result).toMatchObject({ status: 'ready', kind: 'text', truncated: true })
    if (result.status === 'ready') expect(result.content.length).toBe(192 * 1024)
    expect(fetcher).toHaveBeenCalledWith(
      '/api/artifact?versionId=v',
      expect.objectContaining({ method: 'GET', credentials: 'same-origin' })
    )
  })
})
