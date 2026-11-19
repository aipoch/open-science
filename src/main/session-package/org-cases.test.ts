import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DownloadSourceError } from '@aipoch/resilient-download'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LabView } from '../../shared/lab'
import {
  parseOrgCaseDetailResponse,
  parseOrgCasesPage,
  type OrgCaseDetail,
  type OrgCaseDownloadSnapshot,
  type OrgCaseDownloadTicket,
  type OrgCaseItem,
  type OrgCasesPage
} from '../../shared/org-cases'
import { PACKAGE_MAX_BYTES } from '../../shared/session-package'
import { PackageCapacityError } from './capacity'
import { OrgCaseFailure, OrgCaseService } from './org-cases'

function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function responseWithUrl(url: string, body: BodyInit | null, init?: ResponseInit): Response {
  const response = new Response(body, init)
  Object.defineProperty(response, 'url', { value: url })
  return response
}

function makeCaseItem(id = 'case_1', code = '7Q2M9X4B'): OrgCaseItem {
  return {
    id,
    name: 'Sample analysis',
    code,
    description: 'Replace sample data before rerunning.',
    size_bytes: 12,
    sha256: 'a'.repeat(64),
    created_at: '2026-11-17T00:00:00Z',
    owner: { id: 'usr_1', display_name: 'Alice' },
    can_delete: false,
    summary: {
      schema_version: 1,
      features: ['content-dedupe'],
      file_count: 3,
      total_bytes: 1024,
      excluded_files: 1,
      omission_count: 1,
      omissions: [{ kind: 'missing', description: 'one input was not exported' }]
    }
  }
}

describe('OrgCaseService', () => {
  let tempRoot: string

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'org-cases-test-'))
  })

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  it('maps unconfigured, signed-out, and expired Lab states without hitting Lab endpoints', async () => {
    let view: LabView = { state: 'unconfigured' }
    const listLabCases = vi.fn()
    const getLabCase = vi.fn()
    const getLabCaseDownload = vi.fn()
    const service = new OrgCaseService({
      getLabView: () => view,
      listLabCases,
      getLabCase,
      getLabCaseDownload,
      enqueuePackageFile: vi.fn(async () => true),
      tempRootDir: tempRoot
    })

    await expect(service.listCases()).resolves.toEqual({ ok: false, errorCode: 'unconfigured' })
    view = { state: 'signedOut', serverUrl: 'https://lab.example.com' }
    await expect(service.getCase('case_1')).resolves.toEqual({ ok: false, errorCode: 'signed-out' })
    view = { state: 'expired', serverUrl: 'https://lab.example.com', accountName: 'Alice' }
    await expect(service.importCase('case_1')).resolves.toEqual({
      status: 'failed',
      caseId: 'case_1',
      errorCode: 'expired'
    })
    view = {
      state: 'blocked',
      serverUrl: 'https://lab.example.com',
      error: { code: 'license-inactive' }
    }
    await expect(service.listCases()).resolves.toEqual({
      ok: false,
      errorCode: 'license-inactive'
    })

    expect(listLabCases).not.toHaveBeenCalled()
    expect(getLabCase).not.toHaveBeenCalled()
    expect(getLabCaseDownload).not.toHaveBeenCalled()
  })

  it('lists and fetches case details and rejects invalid case identifiers before hitting Lab', async () => {
    const item = makeCaseItem('case_abc', '7Q2M9X4B')
    const listLabCases = vi.fn(async () => ({
      items: [item],
      total: 1,
      page: 1,
      page_size: 20
    }))
    const getLabCase = vi.fn(async () => ({ ...item, original_filename: 'sample.science' }))
    const service = new OrgCaseService({
      getLabView: () => ({
        state: 'authenticated',
        serverUrl: 'https://lab.example.com',
        accountName: 'Alice',
        orgId: 'org_1'
      }),
      listLabCases,
      getLabCase,
      getLabCaseDownload: vi.fn(),
      enqueuePackageFile: vi.fn(async () => true),
      tempRootDir: tempRoot
    })

    await expect(service.listCases({ q: '7Q2M9X4B', page: 1 })).resolves.toEqual({
      ok: true,
      page: { items: [item], total: 1, page: 1, page_size: 20 }
    })
    await expect(service.getCase('case_abc')).resolves.toEqual({
      ok: true,
      case: { ...item, original_filename: 'sample.science' }
    })
    await expect(service.getCase('../etc/passwd')).resolves.toEqual({
      ok: false,
      errorCode: 'not-found'
    })
    expect(getLabCase).toHaveBeenCalledOnce()
  })

  it('preserves STORAGE_NOT_CONFIGURED and Lab domain error codes', async () => {
    const labView: LabView = {
      state: 'authenticated',
      serverUrl: 'https://lab.example.com',
      accountName: 'Alice',
      orgId: 'org_1'
    }
    const listLabCases = vi.fn(async () => {
      throw Object.assign(new Error('storage not configured'), {
        code: 'server-error',
        status: 503,
        reason: 'STORAGE_NOT_CONFIGURED'
      })
    })
    const getLabCase = vi.fn(async () => {
      throw Object.assign(new Error('not found'), {
        code: 'server-error',
        status: 404,
        reason: 'CASE_NOT_FOUND'
      })
    })
    const service = new OrgCaseService({
      getLabView: () => labView,
      listLabCases,
      getLabCase,
      getLabCaseDownload: vi.fn(),
      enqueuePackageFile: vi.fn(async () => true),
      tempRootDir: tempRoot
    })

    await expect(service.listCases({ q: '7Q2M9X4B' })).resolves.toEqual({
      ok: false,
      errorCode: 'storage-not-configured'
    })
    await expect(service.getCase('case_missing')).resolves.toEqual({
      ok: false,
      errorCode: 'not-found'
    })
  })

  it('downloads presigned .science file without Lab auth or cookies, verifies sha256/size, hands off to enqueuePackageFile, and releases temp file on callback', async () => {
    const payload = Buffer.from('verified-science-package-bytes')
    const digest = sha256Hex(payload)
    const snapshots: Array<OrgCaseDownloadSnapshot | null> = []
    const observedRequests: Array<{
      url: string
      authHeader: string | null
      cookieHeader: string | null
      credentials: RequestCredentials | undefined
      redirect: RequestRedirect | undefined
    }> = []

    const ticket: OrgCaseDownloadTicket = {
      url: 'https://storage.example.test/bucket/case_1.science?X-Amz-Signature=sig',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      size_bytes: payload.length,
      sha256: digest,
      name: 'RNAseq Workflow',
      code: '7Q2M9X4B'
    }

    let handedOffPath: string | undefined
    let handedOffRelease: (() => void) | undefined

    const enqueuePackageFile = vi.fn(
      async (path: string, onReleased?: () => void, validateBeforeTarget?: boolean) => {
        expect(validateBeforeTarget).toBe(true)
        expect(existsSync(path)).toBe(true)
        expect(path.endsWith('.science')).toBe(true)
        handedOffPath = path
        handedOffRelease = onReleased
        return true
      }
    )

    const mockFetch: typeof fetch = vi.fn(async (input, init) => {
      const headers = new Headers(init?.headers)
      observedRequests.push({
        url: String(input),
        authHeader: headers.get('authorization'),
        cookieHeader: headers.get('cookie'),
        credentials: init?.credentials,
        redirect: init?.redirect
      })
      return responseWithUrl(String(input), new Uint8Array(payload), {
        status: 200,
        headers: { 'content-length': String(payload.length) }
      })
    })

    const service = new OrgCaseService({
      getLabView: () => ({
        state: 'authenticated',
        serverUrl: 'https://lab.example.com',
        accountName: 'Alice',
        orgId: 'org_1'
      }),
      listLabCases: vi.fn<() => Promise<OrgCasesPage>>(),
      getLabCase: vi.fn<() => Promise<OrgCaseDetail>>(),
      getLabCaseDownload: vi.fn(async () => ticket),
      enqueuePackageFile,
      publishDownloadChanged: (snapshot) => snapshots.push(snapshot),
      downloadFetch: mockFetch,
      assertCapacity: vi.fn(async () => undefined),
      tempRootDir: tempRoot
    })

    const result = await service.importCase('case_1')
    expect(result).toEqual({ status: 'handed-off', caseId: 'case_1' })
    expect(enqueuePackageFile).toHaveBeenCalledOnce()
    expect(observedRequests).toEqual([
      {
        url: ticket.url,
        authHeader: null,
        cookieHeader: null,
        credentials: 'omit',
        redirect: 'error'
      }
    ])
    expect(snapshots[0]?.state).toBe('preparing')
    expect(snapshots.some((item) => item?.state === 'verifying')).toBe(true)
    expect(snapshots.at(-1)).toMatchObject({
      caseId: 'case_1',
      name: 'RNAseq Workflow',
      code: '7Q2M9X4B',
      state: 'handed-off',
      completedBytes: payload.length,
      totalBytes: payload.length
    })

    handedOffRelease?.()
    await vi.waitFor(async () => {
      expect(existsSync(handedOffPath!)).toBe(false)
      expect(await readdir(tempRoot)).toEqual([])
    })
  })

  it('never triggers enqueuePackageFile when checksum verification fails and cleans temp dir', async () => {
    const payload = Buffer.from('corrupted-bytes')
    const wrongSha = '0'.repeat(64)
    const enqueuePackageFile = vi.fn(async () => true)
    const snapshots: Array<OrgCaseDownloadSnapshot | null> = []

    const service = new OrgCaseService({
      getLabView: () => ({
        state: 'authenticated',
        serverUrl: 'https://lab.example.com',
        accountName: 'Alice',
        orgId: 'org_1'
      }),
      listLabCases: vi.fn(),
      getLabCase: vi.fn(),
      getLabCaseDownload: vi.fn(async () => ({
        url: 'https://storage.example.test/case_1.science',
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        size_bytes: payload.length,
        sha256: wrongSha,
        name: 'Bad Case',
        code: '7Q2M9X4B'
      })),
      enqueuePackageFile,
      publishDownloadChanged: (snapshot) => snapshots.push(snapshot),
      downloadFetch: vi.fn(async (input) =>
        responseWithUrl(String(input), new Uint8Array(payload), { status: 200 })
      ),
      assertCapacity: vi.fn(async () => undefined),
      tempRootDir: tempRoot
    })

    await expect(service.importCase('case_1')).resolves.toEqual({
      status: 'failed',
      caseId: 'case_1',
      errorCode: 'verification-failed'
    })
    expect(enqueuePackageFile).not.toHaveBeenCalled()
    expect(snapshots.at(-1)).toMatchObject({
      caseId: 'case_1',
      state: 'failed',
      errorCode: 'verification-failed'
    })
    expect(await readdir(tempRoot)).toEqual([])
  })

  it('rejects oversized packages and capacity errors without starting download or import', async () => {
    const download = vi.fn()
    const enqueuePackageFile = vi.fn(async () => true)
    const service = new OrgCaseService({
      getLabView: () => ({
        state: 'authenticated',
        serverUrl: 'https://lab.example.com',
        accountName: 'Alice',
        orgId: 'org_1'
      }),
      listLabCases: vi.fn(),
      getLabCase: vi.fn(),
      getLabCaseDownload: vi
        .fn()
        .mockResolvedValueOnce({
          url: 'https://storage.example.test/huge.science',
          expires_at: new Date(Date.now() + 300_000).toISOString(),
          size_bytes: PACKAGE_MAX_BYTES + 1,
          sha256: 'a'.repeat(64),
          name: 'Too big',
          code: '7Q2M9X4B'
        })
        .mockResolvedValueOnce({
          url: 'https://storage.example.test/ok.science',
          expires_at: new Date(Date.now() + 300_000).toISOString(),
          size_bytes: 128,
          sha256: 'a'.repeat(64),
          name: 'No disk',
          code: '7Q2M9X4B'
        }),
      enqueuePackageFile,
      download,
      assertCapacity: vi.fn(async () => {
        throw new PackageCapacityError('insufficient disk', 10, 128, new Error('ENOSPC'))
      }),
      tempRootDir: tempRoot
    })

    await expect(service.importCase('case_huge')).resolves.toEqual({
      status: 'failed',
      caseId: 'case_huge',
      errorCode: 'capacity'
    })
    await expect(service.importCase('case_disk')).resolves.toEqual({
      status: 'failed',
      caseId: 'case_disk',
      errorCode: 'capacity'
    })
    expect(download).not.toHaveBeenCalled()
    expect(enqueuePackageFile).not.toHaveBeenCalled()
  })

  it('rejects expired or HTTP-403 presigned download URLs cleanly', async () => {
    const enqueuePackageFile = vi.fn(async () => true)
    const service = new OrgCaseService({
      getLabView: () => ({
        state: 'authenticated',
        serverUrl: 'https://lab.example.com',
        accountName: 'Alice',
        orgId: 'org_1'
      }),
      listLabCases: vi.fn(),
      getLabCase: vi.fn(),
      getLabCaseDownload: vi
        .fn()
        .mockResolvedValueOnce({
          url: 'https://storage.example.test/old.science',
          expires_at: '2020-01-01T00:00:00Z',
          size_bytes: 100,
          sha256: 'a'.repeat(64),
          name: 'Expired',
          code: '7Q2M9X4B'
        })
        .mockResolvedValueOnce({
          url: 'https://storage.example.test/forbidden.science',
          expires_at: new Date(Date.now() + 300_000).toISOString(),
          size_bytes: 100,
          sha256: 'a'.repeat(64),
          name: 'Expired mid-flight',
          code: '7Q2M9X4B'
        }),
      enqueuePackageFile,
      downloadFetch: vi.fn(async (input) =>
        responseWithUrl(String(input), 'expired', { status: 403 })
      ),
      assertCapacity: vi.fn(async () => undefined),
      tempRootDir: tempRoot
    })

    await expect(service.importCase('case_expired')).resolves.toEqual({
      status: 'failed',
      caseId: 'case_expired',
      errorCode: 'url-expired'
    })
    await expect(service.importCase('case_forbidden')).resolves.toEqual({
      status: 'failed',
      caseId: 'case_forbidden',
      errorCode: 'url-expired'
    })
    expect(enqueuePackageFile).not.toHaveBeenCalled()
  })

  it.each([
    {
      scope: 'server and organization switch',
      change: { serverUrl: 'https://lab-b.example.com', orgId: 'org_b' }
    },
    { scope: 'same-name account switch', change: { accountId: 'usr_2' } }
  ])('cancels pending Lab operations on $scope', async ({ change }) => {
    let view: LabView = {
      state: 'authenticated',
      serverUrl: 'https://lab-a.example.com',
      accountId: 'usr_1',
      accountName: 'Alice',
      orgId: 'org_a'
    }
    const enqueuePackageFile = vi.fn(async () => true)
    const snapshots: Array<OrgCaseDownloadSnapshot | null> = []

    let releaseDownload: (() => void) | undefined
    const service = new OrgCaseService({
      getLabView: () => view,
      listLabCases: vi.fn(
        async (_query, signal) =>
          new Promise<OrgCasesPage>((_resolve, reject) => {
            signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError'))
            )
          })
      ),
      getLabCase: vi.fn(),
      getLabCaseDownload: vi.fn(async () => ({
        url: 'https://storage.example.test/case.science',
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        size_bytes: 10,
        sha256: sha256Hex(Buffer.from('1234567890')),
        name: 'Long Case',
        code: '7Q2M9X4B'
      })),
      enqueuePackageFile,
      publishDownloadChanged: (snapshot) => snapshots.push(snapshot),
      assertCapacity: vi.fn(async () => undefined),
      download: vi.fn(
        async (_url, dest, opts) =>
          new Promise<string>((resolve, reject) => {
            opts?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError'))
            )
            releaseDownload = async () => {
              await writeFile(dest, Buffer.from('1234567890'))
              resolve(dest)
            }
          })
      ),
      tempRootDir: tempRoot
    })

    const searchPromise = service.listCases({ q: 'old' })
    const importPromise = service.importCase('case_1')

    await vi.waitFor(() => expect(releaseDownload).toBeTypeOf('function'))

    view = { ...view, accountName: 'Alice Chen' }
    service.handleLabViewChanged(view)
    expect(service.hasActiveDownload()).toBe(true)

    view = { ...view, ...change }
    service.handleLabViewChanged(view)

    await expect(searchPromise).resolves.toEqual({ ok: false, errorCode: 'cancelled' })
    await expect(importPromise).resolves.toEqual({ status: 'cancelled', caseId: 'case_1' })
    expect(enqueuePackageFile).not.toHaveBeenCalled()
    expect(service.hasActiveDownload()).toBe(false)
    expect(snapshots.at(-1)).toBeNull()
    expect(await readdir(tempRoot)).toEqual([])
    expect(releaseDownload).toBeTypeOf('function')

    // Explicit user cancel also works cleanly
    const secondImport = service.importCase('case_2')
    await vi.waitFor(() => expect(service.hasActiveDownload()).toBe(true))
    expect(service.cancelImport('case_2')).toEqual({ cancelled: true })
    await expect(secondImport).resolves.toEqual({ status: 'cancelled', caseId: 'case_2' })
    expect(snapshots.at(-1)).toMatchObject({ caseId: 'case_2', state: 'cancelled' })
  })

  it('prevents concurrent downloads and rolls back temp dir if enqueuePackageFile declines', async () => {
    let resolveFirstDownload: (() => void) | undefined
    const service = new OrgCaseService({
      getLabView: () => ({
        state: 'authenticated',
        serverUrl: 'https://lab.example.com',
        accountName: 'Alice',
        orgId: 'org_1'
      }),
      listLabCases: vi.fn(),
      getLabCase: vi.fn(),
      getLabCaseDownload: vi.fn(async () => ({
        url: 'https://storage.example.test/case.science',
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        size_bytes: 5,
        sha256: sha256Hex(Buffer.from('hello')),
        name: 'Busy Test',
        code: '7Q2M9X4B'
      })),
      enqueuePackageFile: vi.fn(async () => false),
      assertCapacity: vi.fn(async () => undefined),
      download: vi.fn(
        async (_url, dest) =>
          new Promise<string>((resolve) => {
            resolveFirstDownload = async () => {
              await writeFile(dest, Buffer.from('hello'))
              resolve(dest)
            }
          })
      ),
      tempRootDir: tempRoot
    })

    const first = service.importCase('case_1')
    await vi.waitFor(() => expect(resolveFirstDownload).toBeTypeOf('function'))

    await expect(service.importCase('case_2')).resolves.toEqual({
      status: 'failed',
      caseId: 'case_2',
      errorCode: 'import-busy'
    })

    resolveFirstDownload?.()
    await expect(first).resolves.toEqual({
      status: 'failed',
      caseId: 'case_1',
      errorCode: 'import-busy'
    })
    await vi.waitFor(async () => expect(await readdir(tempRoot)).toEqual([]))
  })

  it('handles empty response.url without redirect, rejects redirects/bad expires_at, and maps 403/404/503', async () => {
    const content = Buffer.from('package-bytes-without-response-url')
    const enqueuePackageFile = vi.fn(async (destPath: string, onReleased?: () => void) => {
      expect(existsSync(destPath)).toBe(true)
      onReleased?.()
      return true
    })

    const service = new OrgCaseService({
      getLabView: () => ({
        state: 'authenticated',
        serverUrl: 'https://lab.example.com',
        accountName: 'Alice',
        orgId: 'org_1'
      }),
      listLabCases: vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('Forbidden'), { status: 403, reason: 'ROLE_REQUIRED' })
        ),
      getLabCase: vi.fn(),
      getLabCaseDownload: vi
        .fn()
        .mockResolvedValueOnce({
          url: 'https://storage.example.test/no-url.science',
          expires_at: new Date(Date.now() + 300_000).toISOString(),
          size_bytes: content.byteLength,
          sha256: sha256Hex(content),
          name: 'Empty Response URL',
          code: '7Q2M9X4B'
        })
        .mockResolvedValueOnce({
          url: 'https://storage.example.test/redirect.science',
          expires_at: new Date(Date.now() + 300_000).toISOString(),
          size_bytes: content.byteLength,
          sha256: sha256Hex(content),
          name: 'Redirected',
          code: '7Q2M9X4B'
        })
        .mockResolvedValueOnce({
          url: 'https://storage.example.test/bad-expiry.science',
          expires_at: 'not-a-timestamp',
          size_bytes: content.byteLength,
          sha256: sha256Hex(content),
          name: 'Invalid Expiry',
          code: '7Q2M9X4B'
        })
        .mockResolvedValueOnce({
          url: 'https://storage.example.test/missing.science',
          expires_at: new Date(Date.now() + 300_000).toISOString(),
          size_bytes: content.byteLength,
          sha256: sha256Hex(content),
          name: 'Missing Object',
          code: '7Q2M9X4B'
        })
        .mockResolvedValueOnce({
          url: 'https://storage.example.test/down.science',
          expires_at: new Date(Date.now() + 300_000).toISOString(),
          size_bytes: content.byteLength,
          sha256: sha256Hex(content),
          name: 'Storage Down',
          code: '7Q2M9X4B'
        }),
      enqueuePackageFile,
      assertCapacity: vi.fn(async () => undefined),
      downloadFetch: vi
        .fn()
        .mockResolvedValueOnce(new Response(content, { status: 200 }))
        .mockResolvedValueOnce(
          (() => {
            const res = new Response(content, { status: 200 })
            Object.defineProperty(res, 'redirected', { value: true })
            return res
          })()
        )
        .mockResolvedValueOnce(
          responseWithUrl('https://storage.example.test/missing.science', '', { status: 404 })
        )
        .mockResolvedValueOnce(
          responseWithUrl('https://storage.example.test/down.science', '', { status: 503 })
        ),
      tempRootDir: tempRoot
    })

    await expect(service.listCases({ page: 1 })).resolves.toEqual({
      ok: false,
      errorCode: 'forbidden'
    })
    await expect(service.importCase('case_empty_url')).resolves.toEqual({
      status: 'handed-off',
      caseId: 'case_empty_url'
    })
    await expect(service.importCase('case_redirect')).resolves.toEqual({
      status: 'failed',
      caseId: 'case_redirect',
      errorCode: 'invalid-response'
    })
    await expect(service.importCase('case_bad_expiry')).resolves.toEqual({
      status: 'failed',
      caseId: 'case_bad_expiry',
      errorCode: 'invalid-response'
    })
    await expect(service.importCase('case_404')).resolves.toEqual({
      status: 'failed',
      caseId: 'case_404',
      errorCode: 'not-found'
    })
    await expect(service.importCase('case_503')).resolves.toEqual({
      status: 'failed',
      caseId: 'case_503',
      errorCode: 'storage-unavailable'
    })
    expect(enqueuePackageFile).toHaveBeenCalledTimes(1)
  })

  it('cancels queued package file and preserves expired state when session changes during handoff', async () => {
    let view: LabView = {
      state: 'authenticated',
      serverUrl: 'https://lab.example.com',
      accountName: 'Alice',
      orgId: 'org_1'
    }
    const content = Buffer.from('handoff-race')
    let releaseEnqueue: (() => void) | undefined
    let queuedPath: string | undefined
    const cancelQueuedFile = vi.fn(async () => undefined)

    const service = new OrgCaseService({
      getLabView: () => view,
      listLabCases: vi.fn(),
      getLabCase: vi.fn(),
      getLabCaseDownload: vi.fn(async () => ({
        url: 'https://storage.example.test/race.science',
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        size_bytes: content.byteLength,
        sha256: sha256Hex(content),
        name: 'Handoff Race',
        code: '7Q2M9X4B'
      })),
      enqueuePackageFile: vi.fn(
        (destPath) =>
          new Promise<boolean>((resolve) => {
            queuedPath = destPath
            releaseEnqueue = () => resolve(true)
          })
      ),
      cancelQueuedFile,
      assertCapacity: vi.fn(async () => undefined),
      download: vi.fn(async (_url, dest) => {
        await writeFile(dest, content)
        return dest
      }),
      tempRootDir: tempRoot
    })

    const importing = service.importCase('case_race')
    await vi.waitFor(() => expect(releaseEnqueue).toBeTypeOf('function'))

    view = { state: 'expired', serverUrl: 'https://lab.example.com' }
    service.handleLabViewChanged(view)
    releaseEnqueue?.()

    await expect(importing).resolves.toEqual({
      status: 'failed',
      caseId: 'case_race',
      errorCode: 'expired'
    })
    expect(cancelQueuedFile).toHaveBeenCalledWith(queuedPath)
    expect(await readdir(tempRoot)).toEqual([])
  })

  it('maps real resilientDownload short-read to verification-failed and stalled DownloadSourceError to timeout', async () => {
    const expected = Buffer.from('expected-100-bytes-payload'.padEnd(100, 'x'))
    let truncatedController: ReadableStreamDefaultController<Uint8Array> | undefined
    const shortBody = new ReadableStream<Uint8Array>({
      start(ctrl) {
        truncatedController = ctrl
        ctrl.enqueue(new Uint8Array([1, 2, 3, 4, 5]))
        ctrl.close()
      }
    })
    void truncatedController

    const serviceShortRead = new OrgCaseService({
      getLabView: () => ({
        state: 'authenticated',
        serverUrl: 'https://lab.example.com',
        accountName: 'Alice',
        orgId: 'org_1'
      }),
      listLabCases: vi.fn(),
      getLabCase: vi.fn(),
      getLabCaseDownload: vi.fn(async () => ({
        url: 'https://storage.example.test/truncated.science',
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        size_bytes: expected.byteLength,
        sha256: sha256Hex(expected),
        name: 'Short Read',
        code: '7Q2M9X4B'
      })),
      enqueuePackageFile: vi.fn(async () => true),
      assertCapacity: vi.fn(async () => undefined),
      downloadFetch: vi.fn(async (input) =>
        responseWithUrl(String(input), shortBody, {
          status: 200,
          headers: { 'content-length': String(expected.byteLength) }
        })
      ),
      tempRootDir: tempRoot
    })

    await expect(serviceShortRead.importCase('case_short')).resolves.toEqual({
      status: 'failed',
      caseId: 'case_short',
      errorCode: 'verification-failed'
    })

    const serviceStalled = new OrgCaseService({
      getLabView: () => ({
        state: 'authenticated',
        serverUrl: 'https://lab.example.com',
        accountName: 'Alice',
        orgId: 'org_1'
      }),
      listLabCases: vi.fn(),
      getLabCase: vi.fn(),
      getLabCaseDownload: vi.fn(async () => ({
        url: 'https://storage.example.test/stalled.science',
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        size_bytes: 10,
        sha256: sha256Hex(Buffer.from('1234567890')),
        name: 'Stalled',
        code: '7Q2M9X4B'
      })),
      enqueuePackageFile: vi.fn(async () => true),
      assertCapacity: vi.fn(async () => undefined),
      download: vi.fn(async () => {
        throw new DownloadSourceError('stalled >60000ms', {
          cause: new Error('stalled >60000ms')
        })
      }),
      tempRootDir: tempRoot
    })

    await expect(serviceStalled.importCase('case_stalled')).resolves.toEqual({
      status: 'failed',
      caseId: 'case_stalled',
      errorCode: 'timeout'
    })
  })

  it('rejects with import-busy when desktop import surface is active and awaits temp cleanup on release', async () => {
    let busy = true
    const getLabCaseDownload = vi.fn(async () => ({
      url: 'https://storage.example.test/busy.science',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      size_bytes: 5,
      sha256: sha256Hex(Buffer.from('hello')),
      name: 'Desktop Busy',
      code: '7Q2M9X4B'
    }))
    let releasedDir: Promise<void> | undefined
    const enqueuePackageFile = vi.fn(async (_destPath: string, onReleased?: () => void) => {
      releasedDir = (onReleased as (() => Promise<void>) | undefined)?.()
      return true
    })

    const service = new OrgCaseService({
      getLabView: () => ({
        state: 'authenticated',
        serverUrl: 'https://lab.example.com',
        accountName: 'Alice',
        orgId: 'org_1'
      }),
      listLabCases: vi.fn(),
      getLabCase: vi.fn(),
      getLabCaseDownload,
      isImportBusy: () => busy,
      enqueuePackageFile,
      assertCapacity: vi.fn(async () => undefined),
      download: vi.fn(async (_url, dest) => {
        await writeFile(dest, Buffer.from('hello'))
        return dest
      }),
      tempRootDir: tempRoot
    })

    await expect(service.importCase('case_busy_early')).resolves.toEqual({
      status: 'failed',
      caseId: 'case_busy_early',
      errorCode: 'import-busy'
    })
    expect(getLabCaseDownload).not.toHaveBeenCalled()

    busy = false
    await expect(service.importCase('case_release_promise')).resolves.toEqual({
      status: 'handed-off',
      caseId: 'case_release_promise'
    })
    await releasedDir
    expect(await readdir(tempRoot)).toEqual([])
  })

  it('tolerates JSON null on optional organization case metadata fields', () => {
    const rawItem = {
      ...makeCaseItem(),
      description: null,
      can_delete: null,
      owner: { id: 'usr_1', display_name: null },
      summary: {
        schema_version: 1,
        features: null,
        file_count: 1,
        total_bytes: 10,
        excluded_files: 0,
        omission_count: 1,
        omissions: [{ kind: 'missing', description: null }]
      }
    }
    expect(parseOrgCasesPage({ items: [rawItem], total: 1, page: 1, page_size: 20 })).toMatchObject(
      {
        items: [
          {
            description: '',
            owner: { display_name: '' },
            summary: { features: [], omissions: [{ kind: 'missing', description: '' }] }
          }
        ]
      }
    )
    expect(
      parseOrgCaseDetailResponse({ case: { ...rawItem, original_filename: null } })
    ).toMatchObject({
      original_filename: ''
    })
  })

  it('uploads cases via uploadLabCase, maps server errors cleanly, and aborts on connection switch', async () => {
    let view: LabView = {
      state: 'authenticated',
      serverUrl: 'https://lab.example.com',
      accountName: 'Alice',
      orgId: 'org_1'
    }
    const created: OrgCaseDetail = {
      ...makeCaseItem('case_uploaded', 'ABCD1234'),
      original_filename: 'case.science'
    }

    let rejectPendingUpload: ((reason?: unknown) => void) | undefined
    const uploadLabCase = vi.fn(
      async (_input: unknown, signal?: AbortSignal): Promise<OrgCaseDetail> => {
        if (uploadLabCase.mock.calls.length === 1) return created
        return new Promise<OrgCaseDetail>((_resolve, reject) => {
          rejectPendingUpload = reject
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
    )

    const service = new OrgCaseService({
      getLabView: () => view,
      listLabCases: vi.fn(),
      getLabCase: vi.fn(),
      getLabCaseDownload: vi.fn(),
      uploadLabCase,
      enqueuePackageFile: vi.fn(),
      tempRootDir: tempRoot
    })

    await expect(
      service.uploadCase({
        archivePath: '/tmp/case.science',
        filename: 'case.science',
        name: 'Case 1',
        clientUploadId: 'upload-12345678'
      })
    ).resolves.toMatchObject({ id: 'case_uploaded', code: 'ABCD1234' })

    const inFlight = service.uploadCase({
      archivePath: '/tmp/case.science',
      filename: 'case.science',
      name: 'Case 2',
      clientUploadId: 'upload-87654321'
    })
    await vi.waitFor(() => expect(rejectPendingUpload).toBeTypeOf('function'))
    view = { state: 'signedOut', serverUrl: 'https://lab.example.com' }
    service.handleLabViewChanged(view)
    await expect(inFlight).rejects.toMatchObject({
      name: 'OrgCaseFailure',
      errorCode: 'signed-out'
    })

    view = {
      state: 'authenticated',
      serverUrl: 'https://lab.example.com',
      accountName: 'Alice',
      orgId: 'org_1'
    }
    service.handleLabViewChanged(view)

    const errorCases: Array<[number, string, string]> = [
      [409, 'UPLOAD_IN_PROGRESS', 'upload-in-progress'],
      [413, 'PACKAGE_TOO_LARGE', 'package-too-large'],
      [422, 'UNSUPPORTED_PACKAGE', 'unsupported-package'],
      [400, 'PACKAGE_INVALID', 'package-invalid'],
      [408, 'UPLOAD_TIMEOUT', 'upload-timeout'],
      [403, 'SEAT_REQUIRED', 'seat-required'],
      [429, 'UPLOAD_BUSY', 'rate-limited'],
      [503, 'STORAGE_NOT_CONFIGURED', 'storage-not-configured']
    ]

    for (const [status, reason, expectedCode] of errorCases) {
      uploadLabCase.mockRejectedValueOnce(
        Object.assign(new Error(reason), { code: 'server-error', status, reason })
      )
      await expect(
        service.uploadCase({
          archivePath: '/tmp/case.science',
          filename: 'case.science',
          name: 'Case Err',
          clientUploadId: 'upload-12345678'
        })
      ).rejects.toSatisfy(
        (error: unknown) => error instanceof OrgCaseFailure && error.errorCode === expectedCode
      )
    }
  })
})
