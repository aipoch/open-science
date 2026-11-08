import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { bucketFetch, executeBucketTask } from './hugging-face-bucket-worker'
import { archiveHuggingFaceOutputs } from './hugging-face-bucket'

const scope = { bucket: 'lab/private', runId: 'one', token: 'hf_test' }
const api = '/api/buckets/lab/private'
const root = 'open-science/one'
const inputs = root + '/inputs'
const outputs = root + '/outputs'
const marker = '.open-science-volume'
const content = Uint8Array.of(0, 255, 128, 13, 10, 1)
const sha256 = createHash('sha256').update(content).digest('hex')
function metadata(): Response {
  return Response.json({ id: scope.bucket, private: true })
}

describe('Hugging Face Bucket channel', () => {
  it('verifies frozen bytes, uploads through Xet, lists and archives declared outputs and retries scoped cleanup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hf-channel-test-'))
    const input = join(dir, 'frozen')
    const keys = new Map<string, Uint8Array>()
    const hashes = new Map<string, string>()
    const xorbs: string[] = []
    let loseResponse = false
    const wire: typeof fetch = async (raw, init) => {
      const url = new URL(String(raw))
      expect(init?.redirect).toBe('error')
      const auth = new Headers(init?.headers).get('authorization')
      if (url.hostname === 'cas-server.xethub.hf.co') {
        expect(auth).toBe('Bearer scoped-write')
        if (url.pathname.includes('/chunks/')) return new Response(null, { status: 404 })
        if (url.pathname.includes('/xorbs/')) xorbs.push(url.pathname)
        else expect(url.pathname).toBe('/v1/shards')
        expect((init?.body as Uint8Array).byteLength).toBeGreaterThan(0)
        return new Response()
      }
      expect(url.origin).toBe('https://huggingface.co')
      expect(auth).toBe('Bearer ' + scope.token)
      if (url.pathname === api) return metadata()
      if (url.pathname === api + '/xet-write-token')
        return Response.json({
          casUrl: 'https://cas-server.xethub.hf.co',
          accessToken: 'scoped-write',
          exp: Math.floor(Date.now() / 1000) + 3600
        })
      if (url.pathname === api + '/batch') {
        for (const row of String(init?.body)
          .split('\n')
          .map((line) => JSON.parse(line))) {
          if (row.type === 'deleteFile') keys.delete(row.path)
          else {
            expect(row.type).toBe('addFile')
            expect(row.xetHash).toMatch(/^[a-f0-9]{64}$/)
            keys.set(row.path, row.path.endsWith(marker) ? Uint8Array.of(10) : content)
          }
        }
        if (loseResponse) {
          loseResponse = false
          throw new Error('lost batch reply')
        }
        return Response.json({ failed: [] })
      }
      if (url.pathname.startsWith(api + '/tree/')) {
        const prefix = url.pathname.slice((api + '/tree/').length) + '/'
        return Response.json(
          [...keys]
            .filter(([k]) => k.startsWith(prefix))
            .map(([path, data]) => ({
              path,
              type: 'file',
              size: data.length,
              ...(hashes.has(path) && { xetHash: hashes.get(path) })
            }))
        )
      }
      const resolvePath = '/buckets/lab/private/resolve/'
      expect(url.pathname.startsWith(resolvePath)).toBe(true)
      const bytes = keys.get(url.pathname.slice(resolvePath.length))
      if (!bytes)
        return new Response(null, { status: 404, headers: { 'x-error-code': 'EntryNotFound' } })
      if (new Headers(init?.headers).has('range'))
        return new Response(null, {
          status: 206,
          headers: { etag: '"test"', 'content-range': 'bytes 0-0/' + bytes.length }
        })
      return new Response(Buffer.from(bytes))
    }
    try {
      await writeFile(input, content)
      const files = [{ path: 'dir/data.bin', localPath: input, bytes: content.length, sha256 }]
      const stage = { ...scope, kind: 'stage' as const, files, maxBytes: content.length }
      await expect(
        executeBucketTask({ ...stage, files: [{ ...files[0], sha256: '0'.repeat(64) }] }, wire)
      ).rejects.toThrow('digest')
      expect(keys.size).toBe(0)
      expect(await executeBucketTask(stage, wire)).toEqual({
        inputs: { bucket: scope.bucket, prefix: inputs },
        outputs: { bucket: scope.bucket, prefix: outputs }
      })
      expect(xorbs.length).toBeGreaterThan(0)
      keys.set(outputs + '/a/b.bin', content)
      keys.set(outputs + '/a/c.bin', content)
      keys.set('open-science/other/outputs/keep', content)
      expect(await executeBucketTask({ ...scope, kind: 'list' }, wire)).toEqual([
        { path: 'a/b.bin', bytes: 6 },
        { path: 'a/c.bin', bytes: 6 }
      ])
      const archive = {
        ...scope,
        kind: 'archive' as const,
        directory: dir,
        maxBytes: 12,
        files: [{ path: 'a/b.bin', bytes: 6, sha256 }, { path: 'a/c.bin' }]
      }
      const receipts = await executeBucketTask(archive, wire)
      expect(receipts).toEqual(
        ['a/b.bin', 'a/c.bin'].map((path) => ({
          path,
          localPath: join(dir, path),
          sha256,
          bytes: 6
        }))
      )
      expect(await readFile(join(dir, 'a/b.bin'))).toEqual(Buffer.from(content))
      await expect(executeBucketTask({ ...archive, maxBytes: 5 }, wire)).rejects.toThrow('budget')
      await expect(
        executeBucketTask({ ...archive, files: [{ path: '../escape' }] }, wire)
      ).rejects.toThrow('Unsafe')
      const expectedOutputs = ['a/b.bin', 'a/c.bin'].map((path) => ({ path, bytes: 6, sha256 }))
      const cleanup = { ...scope, kind: 'cleanup' as const, expectedOutputs }
      keys.set(outputs + '/a/b.bin', Uint8Array.of(33, 33, 33, 33, 33, 33))
      await expect(executeBucketTask(cleanup, wire)).rejects.toThrow('digest changed')
      expect(keys.has(inputs + '/dir/data.bin')).toBe(true)
      keys.set(outputs + '/a/b.bin', content)
      await expect(
        executeBucketTask(
          { ...archive, files: [{ path: 'a/b.bin', xetHash: '1'.repeat(64) }] },
          wire
        )
      ).rejects.toThrow('identity changed')
      keys.set(outputs + '/temporary', content)
      hashes.set(outputs + '/temporary', 'c'.repeat(64))
      const snapshot = {
        ...cleanup,
        discardedOutputs: [{ path: 'temporary', bytes: 6, xetHash: 'd'.repeat(64) }]
      }
      await expect(executeBucketTask(snapshot, wire)).rejects.toThrow(
        'Discarded Bucket output changed'
      )
      expect(keys.has(inputs + '/dir/data.bin')).toBe(true)
      snapshot.discardedOutputs[0].xetHash = 'c'.repeat(64)
      loseResponse = true
      await expect(executeBucketTask(snapshot, wire)).rejects.toThrow('lost batch reply')
      await executeBucketTask(snapshot, wire)
      expect([...keys.keys()]).toEqual(['open-science/other/outputs/keep'])

      const stagedCleanup = {
        ...scope,
        kind: 'cleanup' as const,
        expectedOutputs: [],
        expectedInputs: [
          { path: 'dir/data.bin', bytes: content.length, sha256 },
          { path: 'not-uploaded.bin', bytes: content.length, sha256 }
        ]
      }
      keys.set(inputs + '/dir/data.bin', content)
      keys.set(outputs + '/' + marker, Uint8Array.of(10))
      keys.set(inputs + '/unowned', content)
      await expect(executeBucketTask(stagedCleanup, wire)).rejects.toThrow(
        'Unexpected or changed Bucket input'
      )
      keys.delete(inputs + '/unowned')
      keys.set(inputs + '/dir/data.bin', new Uint8Array(content.length))
      await expect(executeBucketTask(stagedCleanup, wire)).rejects.toThrow('input digest changed')
      expect(keys.has(outputs + '/' + marker)).toBe(true)
      keys.set(inputs + '/dir/data.bin', content)
      keys.set(outputs + '/' + marker, Uint8Array.of(65))
      await expect(executeBucketTask(stagedCleanup, wire)).rejects.toThrow('staging marker changed')
      keys.set(outputs + '/' + marker, Uint8Array.of(10))
      await executeBucketTask(stagedCleanup, wire)
      expect([...keys.keys()]).toEqual(['open-science/other/outputs/keep'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('rejects public buckets and foreign pagination links before data egress', async () => {
    const wire = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: scope.bucket, private: false }))
      .mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(
        Response.json([], { headers: { link: '<https://other.invalid/api>; rel="next"' } })
      )
    await expect(
      executeBucketTask({ ...scope, kind: 'stage', files: [], maxBytes: 0 }, wire)
    ).rejects.toThrow('private')
    await expect(executeBucketTask({ ...scope, kind: 'cleanup' }, wire)).rejects.toThrow(
      'continuation'
    )
    expect(wire).toHaveBeenCalledTimes(3)
  })
  it('only reads signed CDN bytes without forwarding credentials', async () => {
    const wire = vi.fn<typeof fetch>().mockResolvedValue(new Response(content))
    const send = bucketFetch(scope.token, wire)
    const url = 'https://us.aws.cdn.hf.co/chunk?signature=test'
    const response = await send(url, { headers: { Range: 'bytes=0-5' } })
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(content)
    const rejected: RequestInit[] = [
      { method: 'POST' },
      { headers: { Authorization: 'Bearer ' + scope.token } },
      { headers: { Cookie: 'session=test' } }
    ]
    for (const init of rejected) {
      await expect(send(url, init)).rejects.toThrow('credential destination')
    }
    await expect(send('https://us.aws.cdn.hf.co.example/chunk')).rejects.toThrow(
      'credential destination'
    )
    expect(wire).toHaveBeenCalledOnce()
  })
  it('does not release a Hub credential to a forged Xet token URL', async () => {
    const wire = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(
        new Response(null, {
          headers: {
            'content-type': 'application/vnd.xet-fileinfo+json',
            'x-linked-size': '1',
            'x-xet-hash': '1234',
            etag: '"t"',
            link: '<https://cas-server.xethub.hf.co/steal>; rel="xet-auth", <https://cas-server.xethub.hf.co/v1/reconstructions/id>; rel="xet-reconstruction-info"'
          }
        })
      )
    const dir = await mkdtemp(join(tmpdir(), 'hf-guard-'))
    try {
      await expect(
        executeBucketTask(
          { ...scope, kind: 'archive', directory: dir, maxBytes: 1, files: [{ path: 'x' }] },
          wire
        )
      ).rejects.toThrow(/credential destination/)
      expect(wire).toHaveBeenCalledTimes(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('discards a failed archive attempt and handles pre-abort', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hf-worker-failure-'))
    const request = {
      ...scope,
      token: '',
      stagingDirectory: dir,
      maxBytes: 1,
      files: [{ path: 'x' }]
    }
    try {
      // This boundary test runs in source-only and packed builds.
      await expect(
        archiveHuggingFaceOutputs({ ...request, signal: AbortSignal.abort() })
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(await readdir(dir)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
