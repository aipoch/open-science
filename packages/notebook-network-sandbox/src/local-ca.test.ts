import { readFile, stat, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { connect, createServer, rootCertificates } from 'node:tls'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  createClientTrustBundle,
  createLocalCertificateAuthority,
  clientTrustEnvironment
} from '../runtime/src/gateway/local-ca.js'

describe('process inspection CA', () => {
  it('signs only exact DNS hosts, reuses bounded contexts, and disposes signing capability', async () => {
    const ca = await createLocalCertificateAuthority()
    expect(new X509Certificate(ca.certificatePem).ca).toBe(true)
    const context = await ca.getSecureContext('example.test')
    expect(await ca.getSecureContext('example.test')).toBe(context)
    for (const host of ['*.example.test', '127.0.0.1', 'bad/name', 'x, CN=other']) {
      await expect(ca.getSecureContext(host)).rejects.toThrow('Invalid inspection hostname')
    }
    for (let index = 0; index < 64; index++) await ca.getSecureContext(`host${index}.test`)
    expect(await ca.getSecureContext('example.test')).not.toBe(context)
    ca.dispose()
    await expect(ca.getSecureContext('example.test')).rejects.toThrow('closed')
  })

  it('bounds in-flight signing without converting resource pressure into an approval error', async () => {
    const ca = await createLocalCertificateAuthority()
    const pending = Array.from({ length: 4 }, (_, index) =>
      ca.getSecureContext(`pending${index}.test`)
    )
    await expect(ca.getSecureContext('fifth.test')).rejects.toMatchObject({
      code: 'OPEN_SCIENCE_NETWORK_RESOURCE_LIMIT'
    })
    await Promise.all(pending)
    await expect(ca.getSecureContext('fifth.test')).resolves.toBeDefined()
    ca.dispose()
  })

  it('cannot complete an in-flight signing operation after disposal', async () => {
    const ca = await createLocalCertificateAuthority()
    const pending = ca.getSecureContext('pending.test')
    ca.dispose()
    await expect(pending).rejects.toThrow('closed')
  })

  it('serves a verifiable exact-host certificate only when its client CA is trusted', async () => {
    const ca = await createLocalCertificateAuthority()
    const context = await ca.getSecureContext('example.test')
    const server = createServer(
      { SNICallback: (_name, callback) => callback(null, context) },
      (socket) => socket.end()
    )
    server.on('tlsClientError', () => {})
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address() as { port: number }
    try {
      const trusted = connect({
        port: address.port,
        host: '127.0.0.1',
        servername: 'example.test',
        ca: ca.certificatePem
      })
      await once(trusted, 'secureConnect')
      expect(trusted.authorized).toBe(true)
      expect(trusted.getPeerCertificate().subjectaltname).toBe('DNS:example.test')
      trusted.destroy()
      for (const options of [
        { servername: 'other.test', ca: ca.certificatePem },
        { servername: 'example.test', ca: [...rootCertificates] }
      ]) {
        const rejected = connect({ port: address.port, host: '127.0.0.1', ...options })
        await expect(once(rejected, 'secureConnect')).rejects.toThrow()
        rejected.destroy()
      }
    } finally {
      server.close()
      ca.dispose()
    }
  })

  it('adds public and custom roots to a certificate-only read-only bundle without changing the source', async () => {
    const ca = await createLocalCertificateAuthority()
    const custom = await createLocalCertificateAuthority()
    const sourceDirectory = await mkdtemp(join(tmpdir(), 'ca-source-'))
    const source = join(sourceDirectory, 'custom.pem')
    const roots = [...rootCertificates, custom.certificatePem]
    await writeFile(source, roots.join('\n'))
    const bundle = await createClientTrustBundle(roots, ca.certificatePem)
    try {
      const pem = await readFile(bundle.path, 'utf8')
      expect(pem).toContain(custom.certificatePem)
      expect(pem).toContain(ca.certificatePem)
      expect(pem).not.toContain('PRIVATE KEY')
      expect((await stat(bundle.path)).mode & 0o222).toBe(0)
      expect(await readFile(source, 'utf8')).toBe(roots.join('\n'))
      expect(clientTrustEnvironment(bundle.path).REQUESTS_CA_BUNDLE).toBe(bundle.path)
    } finally {
      await bundle.cleanup()
      ca.dispose()
      custom.dispose()
      await rm(sourceDirectory, { recursive: true })
    }
    await expect(stat(bundle.path)).rejects.toThrow()
    await expect(bundle.cleanup()).resolves.toBeUndefined()
  })
})
