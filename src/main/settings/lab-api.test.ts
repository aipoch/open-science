import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LabApi, LabApiError } from './lab-api'

const SERVER = 'https://lab.example.com'

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })

const requestBody = (fetchMock: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> => {
  const call = fetchMock.mock.calls[index]!
  return JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Lab API client', () => {
  it('registers a PKCE login attempt with the stable installation id', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(201, {
        request_id: 'req_1',
        authorization_url: 'https://lab.example.com/oauth/authorize?request_id=req_1',
        expires_at: '2026-11-15T10:05:00Z'
      })
    )
    const api = new LabApi({ fetch: fetchMock, now: () => Date.parse('2026-11-15T10:00:00Z') })
    const attempt = await api.registerLoginAttempt({
      serverUrl: SERVER,
      redirectUri: 'http://127.0.0.1:49152/oauth/callback',
      state: 'state-0123456789abcdef',
      codeChallenge: 'challenge',
      installationId: 'installation-1',
      deviceName: 'lab-mac',
      deviceInfo: { hostname: 'lab-mac', platform: 'darwin' }
    })

    expect(attempt.requestId).toBe('req_1')
    expect(attempt.expiresAt).toBe(Date.parse('2026-11-15T10:05:00Z'))
    expect(requestBody(fetchMock)).toMatchObject({
      client_id: 'open-science-desktop',
      redirect_uri: 'http://127.0.0.1:49152/oauth/callback',
      state: 'state-0123456789abcdef',
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
      installation_id: 'installation-1',
      device_name: 'lab-mac',
      device_info: { hostname: 'lab-mac', platform: 'darwin' }
    })
  })

  it('exchanges the code with the exact registered redirect uri', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        access_token: 'at_1',
        token_type: 'Bearer',
        expires_in: 900,
        refresh_token: 'rt_1',
        refresh_expires_in: 2592000,
        session_expires_at: '2026-12-15T10:00:00Z'
      })
    )
    const api = new LabApi({ fetch: fetchMock, now: () => 1_000 })
    const tokens = await api.exchangeCode({
      serverUrl: SERVER,
      code: 'code_1',
      redirectUri: 'http://127.0.0.1:49152/oauth/callback',
      codeVerifier: 'verifier'
    })
    const body = new URLSearchParams(String((fetchMock.mock.calls[0]![1] as RequestInit).body))
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('redirect_uri')).toBe('http://127.0.0.1:49152/oauth/callback')
    expect(body.get('code_verifier')).toBe('verifier')
    expect(tokens).toMatchObject({ accessToken: 'at_1', refreshToken: 'rt_1', expiresIn: 900 })
  })

  it('aborts an in-flight token exchange when the login is cancelled', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
    )
    const api = new LabApi({ fetch: fetchMock })
    const controller = new AbortController()
    const pending = expect(
      api.exchangeCode({
        serverUrl: SERVER,
        code: 'code_1',
        redirectUri: 'http://127.0.0.1:49152/oauth/callback',
        codeVerifier: 'verifier',
        signal: controller.signal
      })
    ).rejects.toMatchObject({ code: 'cancelled' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    controller.abort()
    await pending
  })

  it('treats invalid_grant on refresh as an expired sign-in', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(400, { error: 'invalid_grant', error_description: 'refresh token rotated' })
      )
    const api = new LabApi({ fetch: fetchMock })
    const error = await api.refreshToken(SERVER, 'rt_old').catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(LabApiError)
    expect((error as LabApiError).code).toBe('unauthorized')
  })

  it('does not retry a failed request', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(502, {}))
    const api = new LabApi({ fetch: fetchMock })
    await expect(api.bootstrap(SERVER, 'at_1')).rejects.toMatchObject({ code: 'server-error' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('maps entitlement failures and the device limit to actionable codes', async () => {
    const cases: Array<[number, unknown, string]> = [
      [403, { error: { code: 'SEAT_REQUIRED' } }, 'seat-required'],
      [403, { error: 'invalid_grant', reason: 'LICENSE_INACTIVE' }, 'license-inactive'],
      [
        409,
        {
          error: 'device limit reached; choose a device to replace',
          details: { device_limit: 2 }
        },
        'device-limit'
      ]
    ]
    for (const [status, body, code] of cases) {
      const api = new LabApi({
        fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(status, body))
      })
      await expect(api.bootstrap(SERVER, 'at_1')).rejects.toMatchObject({ code })
    }
  })

  it('parses bootstrap models and keeps only the fields this client uses', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        user: { id: 'usr_1', display_name: 'Researcher', org_id: 'org_1' },
        device: { id: 'dev_1', name: 'Research workstation' },
        models: [
          {
            id: 'research-default',
            name: 'Research Assistant',
            protocol: 'openai',
            protocols: ['openai', 'openai-response'],
            streaming: true,
            enabled: true,
            available: true,
            capabilities: {
              reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
              modalities: { input: ['text', 'image'] },
              limit: { context: 1_000_000, output: 64_000 }
            },
            upstream_model: 'must-not-be-used'
          },
          { id: 'legacy' },
          { id: 'invalid-protocol', protocol: 42 },
          { id: 'invalid-protocols', protocols: 'openai' }
        ],
        default_model_id: 'research-default',
        model_base_url: '/v1'
      })
    )
    const api = new LabApi({ fetch: fetchMock })
    const bootstrap = await api.bootstrap(SERVER, 'at_1')
    expect(bootstrap.user).toMatchObject({ id: 'usr_1', display_name: 'Researcher' })
    expect(bootstrap.models[0]).toMatchObject({
      id: 'research-default',
      protocols: ['openai', 'openai-response'],
      capabilities: {
        reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
        modalities: { input: ['text', 'image'] },
        limit: { context: 1_000_000, output: 64_000 }
      }
    })
    expect(bootstrap.models[0]).not.toHaveProperty('upstream_model')
    expect(bootstrap.models.slice(1)).toEqual([
      { id: 'legacy' },
      { id: 'invalid-protocol', protocol: '' },
      { id: 'invalid-protocols', protocols: [] }
    ])
  })

  it.each(['', '  '])('rejects bootstrap with an empty user ID %j', async (id) => {
    const api = new LabApi({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(200, {
          user: { id, display_name: 'Researcher' },
          device: { id: 'dev_1' }
        })
      )
    })

    await expect(api.bootstrap(SERVER, 'at_1')).rejects.toMatchObject({ code: 'invalid-response' })
  })

  it('reads the authenticated usage snapshot without exposing the token', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        available: true,
        token: {
          available: true,
          name: 'osl:usr_1:1',
          status: 'active',
          quota: { limit: 500_000, used: 165_900, remaining: 334_100, unlimited: false }
        },
        org: {
          available: true,
          unlimited: false,
          quota: { limit: 69_349_151, used: 166_271, remaining: 69_268_880, unlimited: false }
        },
        effective: { remaining: 334_100, limited_by: 'token' },
        display: {
          per_unit: 500_000,
          exchange_rate: 7.3,
          currency: 'CNY',
          cny: {
            token: { limit: 7.3, used: 2.42, remaining: 4.88 },
            org: { limit: 1_012.3, used: 2.43, remaining: 1_009.87 }
          },
          usd: {
            token: { limit: 1, used: 0.3318, remaining: 0.6682 },
            org: { limit: 138.7, used: 0.33, remaining: 138.37 }
          }
        },
        stale: false
      })
    )
    const api = new LabApi({ fetch: fetchMock })
    const usage = await api.usage(SERVER, 'at_1')
    expect(usage).toMatchObject({
      available: true,
      token: { available: true, quota: { remaining: 334_100 } },
      effective: { limitedBy: 'token' }
    })
    const call = fetchMock.mock.calls[0]!
    expect(String(call[0])).toBe(`${SERVER}/api/me/usage`)
    expect((call[1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer at_1' })
    expect(JSON.stringify(usage)).not.toContain('at_1')
  })

  it('probes only a real Lab service identity', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(200, { service: 'open-science-lab', protocol_version: '1' })
      )
      .mockResolvedValueOnce(jsonResponse(200, { service: 'some-other-service' }))
    const api = new LabApi({ fetch: fetchMock })
    await expect(api.clientBootstrap(SERVER)).resolves.toBeUndefined()
    await expect(api.clientBootstrap(SERVER)).rejects.toMatchObject({ code: 'invalid-response' })
  })

  it('fails fast with a timeout instead of hanging', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          )
        })
    )
    const api = new LabApi({ fetch: fetchMock })
    const pending = api.bootstrap(SERVER, 'at_1').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(9_000)
    const error = await pending
    expect(error).toBeInstanceOf(LabApiError)
    expect((error as LabApiError).code).toBe('timeout')
  })

  it('calls organization cases list, detail, and download endpoints and preserves 503 storage reason', async () => {
    const item = {
      id: 'case_1',
      name: 'RNA workflow',
      code: '7Q2M9X4B',
      description: 'Desc',
      size_bytes: 512,
      sha256: 'a'.repeat(64),
      created_at: '2026-11-17T00:00:00Z',
      owner: { id: 'usr_1', display_name: 'Alice' },
      can_delete: false,
      summary: {
        schema_version: 1,
        features: ['content-dedupe'],
        file_count: 2,
        total_bytes: 512,
        excluded_files: 0,
        omission_count: 0,
        omissions: []
      }
    }
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [item], total: 1, page: 2, page_size: 20 }), {
          status: 200
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ case: { ...item, original_filename: 'workflow.science' } }), {
          status: 200
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            url: 'https://storage.example.test/workflow.science',
            expires_at: '2026-11-17T00:05:00Z',
            size_bytes: 512,
            sha256: 'A'.repeat(64),
            name: 'RNA workflow',
            code: '7Q2M9X4B'
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'STORAGE_NOT_CONFIGURED' } }), {
          status: 503
        })
      )

    const api = new LabApi({ fetch: fetchMock })
    const listPage = await api.listCases('https://lab.example.com', 'tok-1', {
      q: '7Q2M9X4B',
      page: 2,
      pageSize: 20
    })
    expect(listPage.items).toHaveLength(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://lab.example.com/api/cases?q=7Q2M9X4B&page=2&page_size=20'
    )

    const detail = await api.getCase('https://lab.example.com', 'tok-1', 'case_1')
    expect(detail.original_filename).toBe('workflow.science')

    const ticket = await api.getCaseDownload('https://lab.example.com', 'tok-1', 'case_1')
    expect(ticket.sha256).toBe('a'.repeat(64))

    await expect(api.listCases('https://lab.example.com', 'tok-1')).rejects.toMatchObject({
      status: 503,
      reason: 'STORAGE_NOT_CONFIGURED'
    })
    await expect(api.getCase('https://lab.example.com', 'tok-1', '../bad')).rejects.toMatchObject({
      code: 'invalid-response'
    })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('enforces credentials omit, redirect error, and rejects fetch redirect TypeErrors as server-error', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('redirect mode is set to error'))
    const api = new LabApi({ fetch: fetchMock })
    await expect(api.listCases(SERVER, 'tok-1')).rejects.toMatchObject({ code: 'server-error' })
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'omit',
      redirect: 'error'
    })
  })

  it('streams a .science package via POST /api/cases with progress and parses the created case', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-api-upload-'))
    const archivePath = join(dir, 'sample.science')
    const payload = Buffer.from('PK\x03\x04-synthetic-science-archive-bytes')
    writeFileSync(archivePath, payload)

    try {
      const created = {
        id: 'case_upload_1',
        name: 'Uploaded Experiment',
        code: '9A2B3C4D',
        description: 'Key workflow notes',
        size_bytes: payload.byteLength,
        sha256: 'b'.repeat(64),
        created_at: '2026-11-18T00:00:00Z',
        owner: { id: 'usr_1', display_name: 'Alice' },
        can_delete: true,
        original_filename: 'experiment-2026-11-18.science',
        summary: {
          schema_version: 1,
          features: [],
          file_count: 1,
          total_bytes: payload.byteLength,
          excluded_files: 0,
          omission_count: 0,
          omissions: []
        }
      }

      let capturedRaw = ''
      const capturedHeaders: Record<string, string> = {}
      const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
        const headers = new Headers(init?.headers)
        headers.forEach((value, key) => {
          capturedHeaders[key] = value
        })
        capturedRaw = Buffer.from(
          await new Response(init?.body as BodyInit).arrayBuffer()
        ).toString('utf8')
        return jsonResponse(201, { case: created })
      })

      const progressEvents: Array<[number, number]> = []
      const api = new LabApi({ fetch: fetchMock })
      const result = await api.uploadCase(SERVER, 'tok-upload', {
        archivePath,
        filename: 'experiment-2026-11-18.science',
        name: '  Uploaded Experiment  ',
        description: '  Key workflow notes  ',
        clientUploadId: 'upload-12345678',
        onProgress: (completed, total) => progressEvents.push([completed, total])
      })

      expect(result).toMatchObject({
        id: 'case_upload_1',
        name: 'Uploaded Experiment',
        code: '9A2B3C4D',
        description: 'Key workflow notes',
        original_filename: 'experiment-2026-11-18.science'
      })
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${SERVER}/api/cases`)
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        duplex: 'half'
      })
      expect(capturedHeaders.authorization).toBe('Bearer tok-upload')
      expect(capturedHeaders['content-type']).toMatch(
        /^multipart\/form-data; boundary=----OpenScienceBoundary/
      )
      expect(capturedRaw).toContain('name="name"\r\n\r\nUploaded Experiment\r\n')
      expect(capturedRaw).toContain('name="description"\r\n\r\nKey workflow notes\r\n')
      expect(capturedRaw).toContain('name="client_upload_id"\r\n\r\nupload-12345678\r\n')
      expect(capturedRaw).toContain(
        'name="file"; filename="experiment-2026-11-18.science"\r\nContent-Type: application/octet-stream\r\n\r\nPK\x03\x04-synthetic-science-archive-bytes\r\n'
      )
      expect(progressEvents[0]).toEqual([0, payload.byteLength])
      expect(progressEvents.at(-1)).toEqual([payload.byteLength, payload.byteLength])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('validates upload inputs locally and preserves Lab HTTP failure codes on uploadCase', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-api-upload-err-'))
    const archivePath = join(dir, 'empty.science')
    const validPath = join(dir, 'valid.science')
    writeFileSync(archivePath, Buffer.alloc(0))
    writeFileSync(validPath, Buffer.from('valid-bytes'))

    try {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(409, { error: { code: 'UPLOAD_IN_PROGRESS' } }))
        .mockResolvedValueOnce(jsonResponse(413, { error: { code: 'PACKAGE_TOO_LARGE' } }))
        .mockResolvedValueOnce(jsonResponse(408, { error: { code: 'UPLOAD_TIMEOUT' } }))
        .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'SESSION_INVALID' } }))

      const api = new LabApi({ fetch: fetchMock })

      await expect(
        api.uploadCase(SERVER, 'tok', {
          archivePath: validPath,
          filename: 'a.science',
          name: 'Valid',
          clientUploadId: 'bad id!'
        })
      ).rejects.toMatchObject({ code: 'invalid-response' })

      await expect(
        api.uploadCase(SERVER, 'tok', {
          archivePath,
          filename: 'empty.science',
          name: 'Valid',
          clientUploadId: 'upload-12345678'
        })
      ).rejects.toMatchObject({ status: 400, reason: 'PACKAGE_INVALID' })

      expect(fetchMock).not.toHaveBeenCalled()

      await expect(
        api.uploadCase(SERVER, 'tok', {
          archivePath: validPath,
          filename: 'valid.science',
          name: 'Valid',
          clientUploadId: 'upload-12345678'
        })
      ).rejects.toMatchObject({ status: 409, reason: 'UPLOAD_IN_PROGRESS' })

      await expect(
        api.uploadCase(SERVER, 'tok', {
          archivePath: validPath,
          filename: 'valid.science',
          name: 'Valid',
          clientUploadId: 'upload-12345679'
        })
      ).rejects.toMatchObject({ status: 413, reason: 'PACKAGE_TOO_LARGE' })

      await expect(
        api.uploadCase(SERVER, 'tok', {
          archivePath: validPath,
          filename: 'valid.science',
          name: 'Valid',
          clientUploadId: 'upload-12345680'
        })
      ).rejects.toMatchObject({ code: 'timeout', status: 408, reason: 'UPLOAD_TIMEOUT' })

      await expect(
        api.uploadCase(SERVER, 'tok', {
          archivePath: validPath,
          filename: 'valid.science',
          name: 'Valid',
          clientUploadId: 'upload-12345681'
        })
      ).rejects.toMatchObject({ code: 'unauthorized', status: 401 })

      const aborted = new AbortController()
      aborted.abort()
      await expect(
        api.uploadCase(
          SERVER,
          'tok',
          {
            archivePath: validPath,
            filename: 'valid.science',
            name: 'Valid',
            clientUploadId: 'upload-12345682'
          },
          aborted.signal
        )
      ).rejects.toMatchObject({ code: 'cancelled' })

      const midController = new AbortController()
      fetchMock.mockImplementationOnce(async (_url, init) => {
        const reader = (init?.body as ReadableStream<Uint8Array>).getReader()
        await reader.read()
        midController.abort()
        await reader.read().catch(() => undefined)
        throw new DOMException('Aborted', 'AbortError')
      })
      await expect(
        api.uploadCase(
          SERVER,
          'tok',
          {
            archivePath: validPath,
            filename: 'valid.science',
            name: 'Valid',
            clientUploadId: 'upload-12345683'
          },
          midController.signal
        )
      ).rejects.toMatchObject({ code: 'cancelled' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
