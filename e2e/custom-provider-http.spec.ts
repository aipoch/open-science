import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SettingsSnapshot } from '../src/shared/settings'
import { networkInterfaces } from 'node:os'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

test('shares only a saved HTTP model authority and retains it after provider deletion', async ({
  app
}) => {
  const host = Object.values(networkInterfaces())
    .flat()
    .find(
      (address) =>
        address?.family === 'IPv4' &&
        !address.internal &&
        /^(192\.168\.|10\.)/.test(address.address)
    )?.address
  test.skip(!host, 'A private non-loopback interface is required for the remote HTTP policy.')
  let probes = 0
  const server = createServer((req, res) => {
    req.resume()
    probes++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'OK' }],
        usage: { input_tokens: 1, output_tokens: 1 }
      })
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  try {
    const port = (server.address() as AddressInfo).port
    const edit = {
      type: 'custom' as const,
      name: 'HTTP fixture',
      baseUrl: `http://${host}:${port}`,
      model: 'mock-model',
      key: 'synthetic-test-only',
      apiEndpoints: ['messages' as const]
    }
    const page = await app.completeOnboarding()
    const inspect = (): Promise<SettingsSnapshot> =>
      page.evaluate(() => window.api.settings.getSettings())
    const testResult = await page.evaluate(
      (edit) => window.api.settings.validateProvider({ edit }),
      edit
    )
    expect(testResult.ok, JSON.stringify(testResult)).toBe(true)
    expect((await inspect()).notebookNetwork?.trustedPrivateDestinations ?? []).toHaveLength(0)
    const saved = await page.evaluate(
      (edit) => window.api.settings.saveValidatedProvider(edit),
      edit
    )
    expect(saved.validation.ok, JSON.stringify(saved.validation)).toBe(true)
    expect(probes).toBeGreaterThanOrEqual(2)
    const granted = (await inspect()).notebookNetwork?.trustedPrivateDestinations
    expect(granted).toEqual([expect.objectContaining({ hostname: host, port, protocol: 'http' })])
    await page.evaluate((id) => window.api.settings.deleteProvider({ id }), saved.providerId!)
    expect((await inspect()).notebookNetwork?.trustedPrivateDestinations).toEqual(granted)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
