// Required before loading x509's dependency-injection decorators.
import { webcrypto, randomBytes, createPrivateKey } from 'node:crypto'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecureContext, rootCertificates, type SecureContext } from 'node:tls'
import { isIP } from 'node:net'

const crypto = webcrypto as unknown as Crypto
const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' }
const CACHE_SIZE = 64
const MAX_PENDING = 4

export type LocalCertificateAuthority = {
  certificatePem: string
  getSecureContext: (host: string) => Promise<SecureContext>
  dispose: () => void
}

/** Private signing material never leaves this closure or reaches the filesystem. */
export async function createLocalCertificateAuthority(): Promise<LocalCertificateAuthority> {
  await import('reflect-metadata')
  const x509 = await import('@peculiar/x509')
  let keys: CryptoKeyPair | undefined = await crypto.subtle.generateKey(algorithm, false, [
    'sign',
    'verify'
  ])
  const issuer = 'CN=Open Science process inspection CA'
  const certificate = await x509.X509CertificateGenerator.createSelfSigned(
    {
      name: issuer,
      keys,
      serialNumber: randomBytes(16).toString('hex'),
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 365 * 86400_000),
      signingAlgorithm: algorithm,
      extensions: [
        new x509.BasicConstraintsExtension(true, 0, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true)
      ]
    },
    crypto
  )
  const certificatePem = certificate.toString('pem')
  const cache = new Map<string, { context: SecureContext; expires: number }>()
  const pending = new Map<string, Promise<SecureContext>>()
  const getSecureContext = async (host: string): Promise<SecureContext> => {
    // The caller must authenticate and resolve policy before requesting a certificate.
    if (!keys) throw new Error('Inspection CA is closed')
    if (
      isIP(host) ||
      host.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
        host
      )
    )
      throw new Error('Invalid inspection hostname')
    const cached = cache.get(host)
    if (cached && cached.expires > Date.now()) {
      cache.delete(host)
      cache.set(host, cached)
      return cached.context
    }
    cache.delete(host)
    const existing = pending.get(host)
    if (existing) return existing
    if (pending.size >= MAX_PENDING) {
      throw Object.assign(new Error('Inspection certificate capacity exceeded'), {
        code: 'OPEN_SCIENCE_NETWORK_RESOURCE_LIMIT'
      })
    }
    const signingKey = keys.privateKey
    const task = (async () => {
      const leafKeys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])
      if (!keys) throw new Error('Inspection CA is closed')
      const expires = Date.now() + 86400_000
      const leaf = await x509.X509CertificateGenerator.create(
        {
          subject: `CN=${host}`,
          issuer,
          publicKey: leafKeys.publicKey,
          signingKey,
          signingAlgorithm: algorithm,
          serialNumber: randomBytes(16).toString('hex'),
          notBefore: new Date(Date.now() - 60_000),
          notAfter: new Date(expires),
          extensions: [
            new x509.BasicConstraintsExtension(false, undefined, true),
            new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: host }]),
            new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
            new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true)
          ]
        },
        crypto
      )
      const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', leafKeys.privateKey))
      try {
        if (!keys) throw new Error('Inspection CA is closed')
        const context = createSecureContext({
          cert: leaf.toString('pem'),
          key: createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }).export({
            type: 'pkcs8',
            format: 'pem'
          }),
          minVersion: 'TLSv1.2'
        })
        cache.set(host, { context, expires })
        if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
        return context
      } finally {
        der.fill(0)
      }
    })().finally(() => pending.delete(host))
    pending.set(host, task)
    return task
  }
  return {
    certificatePem,
    getSecureContext,
    dispose: () => {
      keys = undefined
      cache.clear()
    }
  }
}

export async function createClientTrustBundle(
  realRoots: readonly string[] | undefined,
  localCertificate: string
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'open-science-client-ca-'))
  const path = join(directory, 'certificates.pem')
  try {
    await writeFile(
      path,
      [...(realRoots ?? rootCertificates), localCertificate].join('\n') + '\n',
      { mode: 0o444 }
    )
    await chmod(directory, 0o555)
  } catch (error) {
    await rm(directory, { force: true, recursive: true })
    throw error
  }
  return {
    path,
    cleanup: async () => {
      try {
        await chmod(directory, 0o700)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      await rm(directory, { force: true, recursive: true })
    }
  }
}

export const clientTrustEnvironment = (path: string): NodeJS.ProcessEnv =>
  Object.fromEntries(
    [
      'CONDA_SSL_VERIFY',
      'SSL_CERT_FILE',
      'REQUESTS_CA_BUNDLE',
      'PIP_CERT',
      'CURL_CA_BUNDLE',
      'NODE_EXTRA_CA_CERTS'
    ].map((key) => [key, path])
  )
