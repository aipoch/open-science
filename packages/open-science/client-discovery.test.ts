import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => fixture.home
}))

import { connectToOpenScience } from './index.mjs'
import { parseCliArgs, runTaskCommand } from './cli.mjs'

beforeEach(async () => {
  fixture.home = await mkdtemp(join(tmpdir(), 'osci-discovery-'))
  for (const [index, name] of ['.open-science-project', '.open-science'].entries()) {
    const root = join(fixture.home, name)
    await mkdir(root)
    await writeFile(
      join(root, 'web-service.json'),
      JSON.stringify({ pid: process.pid, port: 44100 + index, startedAt: new Date().toISOString() })
    )
    await writeFile(join(root, 'web-token'), `fixture-token-${index}`)
  }
})
afterEach(async () => {
  await rm(fixture.home, { recursive: true, force: true })
})

const refused = (): TypeError =>
  new TypeError('fetch failed', {
    cause: Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })
  })

it.each([401, 403, 500])(
  'preserves HTTP %s over connection refusal in either candidate order',
  async (status) => {
    for (const reverse of [false, true]) {
      const fetch = vi.fn(async (url: string) => {
        if (url.includes(reverse ? ':44101/' : ':44100/')) return Response.json({}, { status })
        throw refused()
      })
      const log = vi.fn()
      await expect(
        runTaskCommand(parseCliArgs(['doctor', '--json']), {
          connect: () => connectToOpenScience({ env: {}, fetch }),
          log
        })
      ).rejects.toMatchObject({ status })
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(log).not.toHaveBeenCalled()
    }
  }
)

it('reports a missing daemon when both candidates refuse connections', async () => {
  const log = vi.fn()
  const setExitCode = vi.fn()
  const fetch = vi.fn().mockRejectedValue(refused())
  await runTaskCommand(parseCliArgs(['doctor', '--json']), {
    connect: () => connectToOpenScience({ env: {}, fetch }),
    log,
    setExitCode
  })
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
    ready: false,
    checks: { daemon: { status: 'missing' } }
  })
  expect(setExitCode).toHaveBeenCalledWith(3)
})

it('still connects to a healthy later candidate after an earlier HTTP rejection', async () => {
  const fetch = vi.fn(async (url: string) =>
    Response.json({}, { status: url.includes(':44100/') ? 401 : 200 })
  )
  const client = await connectToOpenScience({ env: {}, fetch })
  expect(client.baseUrl).toBe('http://127.0.0.1:44101')
  expect(fetch).toHaveBeenCalledTimes(2)
})
