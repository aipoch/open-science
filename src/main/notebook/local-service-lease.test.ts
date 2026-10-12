import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalServiceLease } from './local-service-lease'

const servers: Server[] = [],
  leases: LocalServiceLease[] = [],
  roots: string[] = []
afterEach(async () => {
  leases.splice(0).forEach((lease) => lease.close())
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
  )
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const listen = async (
  proof: string,
  socketPath?: string
): Promise<{ server: Server; socketPath: string; paths: string[] }> => {
  if (!socketPath) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'os-service-run-1-')))
    await chmod(root, 0o700)
    roots.push(root)
    socketPath = join(root, 'service.sock')
  }
  const paths: string[] = []
  const server = createServer((req, res) => {
    paths.push(req.url!)
    if (req.url === '/oversized') {
      res.end(Buffer.alloc(1024 * 1024 + 1))
      return
    }
    if (req.url === '/redirect') res.writeHead(302, { location: 'http://example.invalid/' })
    res.end(req.url === '/proof' ? proof : 'fixture-result')
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  return { server, socketPath, paths }
}

const scope = { projectId: 'project', sessionId: 'session', executionId: 'run-1' }
const open = async (
  socketPath: string,
  proof: string,
  signal = new AbortController().signal
): Promise<LocalServiceLease> => {
  const lease = await LocalServiceLease.open({
    scope,
    socketPath,
    expectedProof: proof,
    proofPath: '/proof',
    allowedPaths: ['/result', '/redirect', '/oversized'],
    signal
  })
  leases.push(lease)
  return lease
}

describe.skipIf(process.platform === 'win32')('private Unix service lease', () => {
  it('verifies the generation and allows only declared relative paths without redirects', async () => {
    const proof = randomBytes(32).toString('hex'),
      fixture = await listen(proof)
    const lease = await open(fixture.socketPath, proof)
    expect(lease.scope).toEqual(scope)
    expect((await lease.get('/result')).body.toString()).toBe('fixture-result')
    expect((await lease.get('/redirect')).statusCode).toBe(302)
    for (const path of [
      'http://localhost/result',
      '//localhost/result',
      '/proof',
      '/result?url=x'
    ]) {
      await expect(lease.get(path)).rejects.toThrow('not authorized')
    }
    expect(fixture.paths).toEqual(['/proof', '/result', '/redirect'])
  })

  it('fails closed when an unrelated listener occupies the selected path', async () => {
    const fixture = await listen(randomBytes(32).toString('hex'))
    await expect(open(fixture.socketPath, randomBytes(32).toString('hex'))).rejects.toThrow(
      'generation'
    )
    expect(fixture.paths).toEqual(['/proof'])
  })

  it('rejects a different run identity before contacting the socket', async () => {
    const proof = randomBytes(32).toString('hex')
    const fixture = await listen(proof)
    await expect(
      LocalServiceLease.open({
        scope: { ...scope, executionId: 'another-run' },
        socketPath: fixture.socketPath,
        expectedProof: proof,
        proofPath: '/proof',
        allowedPaths: ['/result'],
        signal: new AbortController().signal
      })
    ).rejects.toThrow('run-owned')
    expect(fixture.paths).toEqual([])
  })

  it('closes the capability when a response exceeds its byte budget', async () => {
    const proof = randomBytes(32).toString('hex')
    const fixture = await listen(proof)
    const lease = await open(fixture.socketPath, proof)
    await expect(lease.get('/oversized')).rejects.toThrow('size limit')
    await expect(lease.get('/result')).rejects.toThrow('closed')
    expect(fixture.paths).toEqual(['/proof', '/oversized'])
  })

  it('revokes immediately on cancellation and never reconnects after path reuse', async () => {
    const proof = randomBytes(32).toString('hex'),
      first = await listen(proof)
    const controller = new AbortController(),
      lease = await open(first.socketPath, proof, controller.signal)
    controller.abort()
    first.server.closeAllConnections()
    await new Promise<void>((resolve) => first.server.close(() => resolve()))
    const replacement = await listen(proof, first.socketPath)
    await expect(lease.get('/result')).rejects.toThrow()
    expect(replacement.paths).toEqual([])
  })

  it('never reconnects after unexpected service exit even if the replacement knows the proof', async () => {
    const proof = randomBytes(32).toString('hex'),
      first = await listen(proof)
    const lease = await open(first.socketPath, proof)
    first.server.closeAllConnections()
    await new Promise<void>((resolve) => first.server.close(() => resolve()))
    const replacement = await listen(proof, first.socketPath)
    await expect(lease.get('/result')).rejects.toThrow()
    expect(replacement.paths).toEqual([])
  })
})
