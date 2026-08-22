import { describe, expect, it } from 'vitest'

import { liveOpencodeAvailable } from './native-send-now-live-probe'
import {
  LIVE_OPENCODE_HTTP_STEER,
  OPENCODE_HTTP_STEER_DELIVERY,
  OPENCODE_HTTP_STEER_PATH,
  buildOpenCodeHttpSteerBody,
  probeOpencodeHttpSteer
} from './native-send-now-opencode-http'

const LIVE = process.env.NATIVE_SEND_NOW_LIVE === '1'

describe('OpenCode HTTP side-band steer spike', () => {
  it('builds the v2 prompt body that live-probed as delivery=steer', () => {
    expect(OPENCODE_HTTP_STEER_PATH).toBe('/api/session/{sessionID}/prompt')
    expect(buildOpenCodeHttpSteerBody('focus on tests')).toEqual({
      delivery: OPENCODE_HTTP_STEER_DELIVERY,
      prompt: { text: 'focus on tests' }
    })
    expect(LIVE_OPENCODE_HTTP_STEER).toEqual({
      v2SteerStatus: 200,
      v2SteerDelivery: 'steer',
      v2QueueStatus: 200,
      v1MessageNoReplyStatus: 200
    })
  })
})

describe.skipIf(!LIVE)('OpenCode HTTP live probe', () => {
  it('admits delivery=steer on the ACP session over the usage HTTP port', async () => {
    expect(liveOpencodeAvailable()).toBe(true)
    const result = await probeOpencodeHttpSteer()
    expect(result.healthOk).toBe(true)
    expect(result.createdSession).toBe(true)
    expect(result.advertisedAcpSteering).toBe(false)
    const steer = result.attempts.find((attempt) => attempt.label === 'v2-steer-text')
    expect(steer?.status).toBe(200)
    expect(JSON.parse(steer?.body ?? '{}')).toMatchObject({
      data: { delivery: 'steer', prompt: { text: 'http-steer' } }
    })
    const queued = result.attempts.find((attempt) => attempt.label === 'v2-queue-text')
    expect(queued?.status).toBe(200)
    expect(JSON.parse(queued?.body ?? '{}')).toMatchObject({ data: { delivery: 'queue' } })
  }, 60_000)
})
