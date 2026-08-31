import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { rootCertificates } from 'node:tls'
import { afterEach, describe, expect, it } from 'vitest'

import { notebookTrustBundleStatus, resolveNotebookTrustBundle } from './trust-bundle'

let directory: string | undefined

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

const bundlePath = async (contents: string): Promise<string> => {
  directory = await mkdtemp(join(tmpdir(), 'open-science-ca-'))
  const path = join(directory, 'bundle.pem')
  await writeFile(path, contents, 'utf8')
  return path
}

describe('Notebook trust bundle', () => {
  it('uses public certificate authorities when no custom path is configured', async () => {
    const bundle = await resolveNotebookTrustBundle('  ')
    expect(bundle).toBeUndefined()
    expect(notebookTrustBundleStatus(bundle)).toEqual({ mode: 'autoPublic' })
  })

  it('validates every PEM certificate and reports the canonical path', async () => {
    const path = await bundlePath(`# Public and corporate roots\n${rootCertificates.join('\n')}\n`)

    await expect(resolveNotebookTrustBundle(path)).resolves.toMatchObject({
      mode: 'custom',
      path: await realpath(path),
      certificateCount: rootCertificates.length
    })
  })

  it('rejects a syntactically valid bundle that would replace the public root set', async () => {
    await expect(
      resolveNotebookTrustBundle(await bundlePath(rootCertificates[0]!))
    ).rejects.toThrow('omits public roots')
  })

  it('rejects missing, malformed, and private-key-bearing bundles', async () => {
    const relativePath = await bundlePath(rootCertificates[0]!)
    await expect(resolveNotebookTrustBundle(relative(process.cwd(), relativePath))).rejects.toThrow(
      'must be absolute'
    )
    await expect(resolveNotebookTrustBundle('/missing/ca.pem')).rejects.toThrow(
      'does not exist or cannot be read'
    )
    await expect(resolveNotebookTrustBundle(await bundlePath('not a certificate'))).rejects.toThrow(
      'does not contain a PEM certificate'
    )
    await expect(
      resolveNotebookTrustBundle(
        await bundlePath(
          `${rootCertificates[0]}\n-----BEGIN ENCRYPTED PRIVATE KEY-----\nsecret\n-----END ENCRYPTED PRIVATE KEY-----`
        )
      )
    ).rejects.toThrow('certificates only, not private keys')
  })

  it.each([
    ['trailing text', `${rootCertificates[0]}\nnot PEM`],
    ['a truncated certificate', `${rootCertificates[0]}\n-----BEGIN CERTIFICATE-----\ntruncated`],
    [
      'an unsupported PEM object',
      `${rootCertificates[0]}\n-----BEGIN PUBLIC KEY-----\nunsupported\n-----END PUBLIC KEY-----`
    ]
  ])('rejects a valid certificate followed by %s', async (_label, contents) => {
    await expect(resolveNotebookTrustBundle(await bundlePath(contents))).rejects.toThrow(
      'incomplete or unsupported PEM content'
    )
  })
})
