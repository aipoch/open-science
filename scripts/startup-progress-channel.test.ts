import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { prepareStartupPresenter } from '../src/main/startup-presenter'

const require = createRequire(import.meta.url)
const { openStartupChannel } = require('../resources/brand-migration/startup-channel.cjs')

it('authenticates a real loopback connection and retains control after migration worker disconnect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'startup-channel-'))
  const messages: unknown[] = []
  let disconnected = false
  const channel = await openStartupChannel(
    { directory, token: 'a'.repeat(64) },
    {
      message: (value: unknown) => messages.push(value),
      disconnected: () => {
        disconnected = true
      }
    }
  )
  try {
    const { port } = JSON.parse(await readFile(join(directory, 'endpoint.json'), 'utf8'))
    const intruder = connect(port, '127.0.0.1')
    const rejected = once(intruder, 'close')
    intruder.write(JSON.stringify({ token: 'wrong', type: 'complete' }) + '\n')
    await rejected
    expect(messages).toEqual([])
    expect(disconnected).toBe(false)
    for (const payload of ['not-json\n', 'x'.repeat(65537)]) {
      const invalid = connect(port, '127.0.0.1')
      invalid.on('error', () => {})
      const closed = new Promise<void>((resolve) => invalid.once('close', () => resolve()))
      invalid.write(payload)
      await closed
    }
    expect(messages).toEqual([])
    const owner = connect(port, '127.0.0.1')
    owner.write(
      JSON.stringify({ token: 'a'.repeat(64), type: 'progress', phase: 'startup-settings' }) + '\n'
    )
    await once(owner, 'data')
    expect(messages).toEqual([{ type: 'progress', phase: 'startup-settings' }])
    const secondOwner = connect(port, '127.0.0.1')
    const secondClosed = once(secondOwner, 'close')
    secondOwner.write(JSON.stringify({ token: 'a'.repeat(64), type: 'complete' }) + '\n')
    await secondClosed
    expect(messages).toHaveLength(1)
    expect(disconnected).toBe(false)
    owner.end()
    await once(owner, 'close')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(disconnected).toBe(true)
  } finally {
    channel.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('hands progress to the real main client and settles once, removing only its endpoint directory', async () => {
  const progress = prepareStartupPresenter()
  const identity = JSON.parse(progress.environment)
  const messages: { type: string; phase?: string }[] = []
  const channel = await openStartupChannel(identity, {
    message: (message: { type: string }) => messages.push(message),
    disconnected: () => {}
  })
  try {
    const presenter = progress.attach()
    await expect.poll(() => messages.at(-1)?.phase).toBe('startup-runtime')
    presenter.update('startup-sessions')
    await expect.poll(() => messages.at(-1)?.phase).toBe('startup-sessions')
    presenter.complete()
    presenter.complete()
    presenter.fail('obsolete error')
    await expect
      .poll(() => messages.filter((message) => message.type === 'complete').length)
      .toBe(1)
    expect(messages.some((message) => message.type === 'failed')).toBe(false)
    await expect(readFile(join(identity.directory, 'endpoint.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  } finally {
    channel.close()
    progress.cleanup()
  }
})
