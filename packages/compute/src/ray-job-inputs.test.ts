import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRayJobsEndpoint } from './ray-jobs-http'
import JSZip from 'jszip'
import { expect, it, vi } from 'vitest'
import { prepareRayJobInputs, uploadRayWorkingDirectory } from './ray-job-inputs'

it('uploads exactly the approved bytes, then pins the same package on retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ray-snapshot-'))
  try {
    const data = Buffer.from([0, 255, 7, 13])
    const localPath = join(root, 'file.bin')
    await writeFile(localPath, data)
    const file = {
      localPath,
      dstFilename: 'input.bin',
      sizeBytes: data.length,
      checksum: createHash('sha256').update(data).digest('hex')
    }
    const packed = await prepareRayJobInputs([file], data.length)
    expect(
      await (await JSZip.loadAsync(packed.zip)).file('input.bin')!.async('nodebuffer')
    ).toEqual(data)
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response())
      .mockResolvedValueOnce(new Response())
    const target = {
      endpoint: 'http://127.0.0.1:8265',
      fetch,
      getToken: vi.fn(async () => 'local-token')
    }
    const uri = await uploadRayWorkingDirectory(target, packed)
    expect(await uploadRayWorkingDirectory(target, packed)).toBe(uri)
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'PUT', 'GET'])
    expect(target.getToken.mock.calls).toEqual(Array(3).fill([target.endpoint]))
    expect(
      fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'))
    ).toEqual(Array(3).fill('Bearer local-token'))
    const [[url], [, put]] = fetch.mock.calls
    expect(String(url)).toBe(
      target.endpoint + '/api/packages/gcs/_ray_pkg_' + packed.sha256 + '.zip'
    )
    expect(put?.body).toEqual(packed.zip)
    await writeFile(localPath, Buffer.alloc(data.length))
    await expect(prepareRayJobInputs([file], data.length)).rejects.toThrow('checksum')
    await expect(
      prepareRayJobInputs([{ ...file, dstFilename: '../escape' }], data.length)
    ).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('pins the explicitly selected Dashboard ahead of saved and environment settings', () => {
  vi.stubEnv('RAY_DASHBOARD_URL', 'http://localhost:9000/')
  try {
    expect(resolveRayJobsEndpoint('https://lab.example/gateway/', 'http://localhost:9001')).toBe(
      'https://lab.example/gateway'
    )
    expect(resolveRayJobsEndpoint(undefined, 'http://localhost:9001')).toBe('http://localhost:9001')
    expect(resolveRayJobsEndpoint()).toBe('http://localhost:9000')
    expect(resolveRayJobsEndpoint('https://lab.example/gateway/?#')).toBe(
      'https://lab.example/gateway'
    )
    expect(() => resolveRayJobsEndpoint('https://user:secret@lab.example')).toThrow(
      'Invalid Ray Dashboard'
    )
  } finally {
    vi.unstubAllEnvs()
  }
})
