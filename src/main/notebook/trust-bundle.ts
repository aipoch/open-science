import { X509Certificate } from 'node:crypto'
import { realpath, readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { rootCertificates } from 'node:tls'

const MAX_CA_BUNDLE_BYTES = 8 * 1024 * 1024
const CERTIFICATE_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:EC |RSA |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/u
const PEM_SEPARATORS_PATTERN = /^(?:\s|#[^\r\n]*(?:\r?\n|$))*$/u

export type NotebookTrustBundle = Readonly<{
  mode: 'custom'
  path: string
  certificates: readonly string[]
  certificateCount: number
}>

export type NotebookTrustBundleStatus =
  | Readonly<{ mode: 'autoPublic' }>
  | Readonly<{ mode: 'custom'; path: string; certificateCount: number }>

export const resolveNotebookTrustBundle = async (
  configuredPath?: string
): Promise<NotebookTrustBundle | undefined> => {
  const candidate = configuredPath?.trim()
  if (!candidate) return undefined
  if (!isAbsolute(candidate)) throw new Error('The CA bundle path must be absolute.')

  let metadata
  try {
    metadata = await stat(candidate)
  } catch {
    throw new Error('The CA bundle path does not exist or cannot be read.')
  }
  if (!metadata.isFile()) throw new Error('The CA bundle path must point to a regular file.')
  if (metadata.size === 0) throw new Error('The CA bundle is empty.')
  if (metadata.size > MAX_CA_BUNDLE_BYTES) {
    throw new Error('The CA bundle is larger than the supported 8 MB limit.')
  }

  const [path, pem] = await Promise.all([realpath(candidate), readFile(candidate, 'utf8')])
  if (PRIVATE_KEY_PATTERN.test(pem)) {
    throw new Error('The CA bundle must contain certificates only, not private keys.')
  }
  const certificates = pem.match(CERTIFICATE_PATTERN) ?? []
  if (certificates.length === 0) {
    throw new Error('The CA bundle does not contain a PEM certificate.')
  }
  if (!PEM_SEPARATORS_PATTERN.test(pem.replace(CERTIFICATE_PATTERN, ''))) {
    throw new Error('The CA bundle contains incomplete or unsupported PEM content.')
  }
  let fingerprints: Set<string>
  try {
    fingerprints = new Set(
      certificates.map((certificate) => new X509Certificate(certificate).fingerprint256)
    )
  } catch {
    throw new Error('The CA bundle contains an invalid PEM certificate.')
  }
  if (
    rootCertificates.some(
      (certificate) => !fingerprints.has(new X509Certificate(certificate).fingerprint256)
    )
  ) {
    throw new Error('The CA bundle omits public roots required by Open Science.')
  }

  return {
    mode: 'custom',
    path,
    certificates,
    certificateCount: certificates.length
  }
}

export const notebookTrustBundleStatus = (
  bundle: NotebookTrustBundle | undefined
): NotebookTrustBundleStatus =>
  bundle
    ? { mode: 'custom', path: bundle.path, certificateCount: bundle.certificateCount }
    : { mode: 'autoPublic' }
