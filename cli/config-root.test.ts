import { describe, expect, it } from 'vitest'

import { TOKEN_FILE as APP_TOKEN_FILE } from '../src/main/web-service/auth'
import { WEB_SERVICE_STATE_FILE } from '../src/main/web-service/state-file'
import { STATE_FILE, TOKEN_FILE } from './config-root.mjs'

// The CLI (a standalone .mjs, separate module system) can't import the app's TypeScript constants at
// runtime, so it re-declares the state/token filenames. This guard fails loudly if the app renames one
// side without the other, which would otherwise silently break `open-science status/stop/url`.
describe('CLI config-root constants stay in lockstep with the app', () => {
  it('uses the same state and token filenames as the web service', () => {
    expect(STATE_FILE).toBe(WEB_SERVICE_STATE_FILE)
    expect(TOKEN_FILE).toBe(APP_TOKEN_FILE)
  })
})
