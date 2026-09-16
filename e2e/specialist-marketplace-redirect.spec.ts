import { expect } from '@playwright/test'
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { test } from './fixtures/electron-app'

// A signed Marketplace with a real ZIP; only the remote HTTP endpoints are replaced.
// The production preload, IPC composition, service, verification and package importer all run.
test('installs a reviewed GitHub Specialist through a Release asset redirect', async ({ app }) => {
  const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
  const fixtureRoot = join(process.cwd(), 'src/main/specialist/package/test-fixtures/valid')
  const archive = Buffer.from(
    zipSync({
      'manifest.json': await readFile(join(fixtureRoot, 'manifest.json')),
      'specialist.json': await readFile(join(fixtureRoot, 'specialist.json'))
    })
  )
  const metadataBase = 'https://raw.githubusercontent.com/example/marketplace/main/'
  const artifactUrl = 'https://github.com/example/marketplace/releases/download/v1/fixture.zip'
  const assetUrl = 'https://release-assets.githubusercontent.com/fixture.zip'
  const releasePath = 'releases/fixture-specialist/1.0.0.json'
  const release = Buffer.from(
    JSON.stringify({
      schema_version: 1,
      specialist_id: 'fixture-specialist',
      version: '1.0.0',
      source: {
        repository: 'https://github.com/example/marketplace',
        commit: 'c'.repeat(40),
        license: 'MIT'
      },
      artifact: {
        path: 'specialists/fixture-specialist/1.0.0/fixture.zip',
        github_release: { tag: 'v1', asset_name: 'fixture.zip' },
        sha256: digest(archive),
        compressed_bytes: archive.length,
        uncompressed_bytes: 1000,
        file_count: 2
      },
      defaults: { skill_ids: [], connector_ids: [] },
      skills: [],
      connectors: []
    })
  )
  const root = Buffer.from(
    JSON.stringify({
      schema_version: 1,
      revision: '1',
      marketplace: { id: 'example', name: 'Redirect fixture' },
      specialists: [
        {
          id: 'fixture-specialist',
          display_name: 'Fixture Specialist',
          summary: 'Redirect fixture',
          publisher: { id: 'example', name: 'Example' },
          latest: { version: '1.0.0', release: { path: releasePath, sha256: digest(release) } }
        }
      ]
    })
  )
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const signature = Buffer.from(
    JSON.stringify({
      schema_version: 1,
      algorithm: 'ed25519',
      key_id: 'fixture',
      public_key: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      signature: sign(null, root, privateKey).toString('base64')
    })
  )
  const responses = new Map([
    [metadataBase + 'marketplace.json', root],
    [metadataBase + 'marketplace.json.sig', signature],
    [metadataBase + releasePath, release],
    [assetUrl, archive]
  ])
  let redirectTarget = assetUrl
  const visited: string[] = []
  const server = createServer((request, response) => {
    const url = decodeURIComponent(request.url!.slice(1))
    visited.push(url)
    if (url === artifactUrl) {
      response.writeHead(302, { location: redirectTarget }).end()
      return
    }
    const bytes = responses.get(url)
    response.writeHead(bytes ? 200 : 404, { 'content-length': bytes?.length ?? 0 }).end(bytes)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture address')
    await app.routeMarketplaceRequests(`http://127.0.0.1:${address.port}`)
    const source = await app.page.evaluate(async () => {
      const candidate = await window.api.specialist.inspectGitHubMarketplaceSource({
        repositoryUrl: 'https://github.com/example/marketplace/tree/main'
      })
      return window.api.specialist.addMarketplaceSource({
        candidateToken: candidate.candidateToken
      })
    })
    const request = { sourceId: source.id, specialistId: 'fixture-specialist', version: '1.0.0' }
    await expect(
      app.page.evaluate((request) => window.api.specialist.getMarketplaceRelease(request), request)
    ).resolves.toMatchObject({ specialistId: 'fixture-specialist', version: '1.0.0' })
    const result = await app.page.evaluate(async (request) => {
      const preview = await window.api.specialist.prepareMarketplaceInstall({
        ...request,
        selectedSkillIds: [],
        selectedConnectorIds: []
      })
      if (!preview.package.installable) throw new Error(JSON.stringify(preview.package.diagnostics))
      return window.api.specialist.installMarketplace({
        candidateToken: preview.package.candidateToken
      })
    }, request)
    expect(result).toMatchObject({
      status: 'installed',
      specialist: { id: 'fixture-specialist' },
      provenanceLinked: true
    })
    expect(visited).toContain(artifactUrl)
    expect(visited).toContain(assetUrl)

    const prepare = (): ReturnType<typeof app.page.evaluate> =>
      app.page.evaluate(
        (request) =>
          window.api.specialist.prepareMarketplaceInstall({
            ...request,
            selectedSkillIds: [],
            selectedConnectorIds: []
          }),
        request
      )
    redirectTarget = 'https://untrusted.invalid/fixture.zip'
    await expect(prepare()).rejects.toThrow('Marketplace host is not allowed')
    expect(visited).not.toContain(redirectTarget)

    redirectTarget = assetUrl
    responses.set(assetUrl, Buffer.alloc(archive.length))
    await expect(prepare()).rejects.toThrow('Marketplace artifact verification failed')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})
