import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { decodeSessionDataPaths, encodeSessionDataPaths } from './session-data-paths'

const ROOT = '/data/os'
const session: PersistedChatSession = {
  id: 's1',
  projectId: 'p',
  title: 't',
  cwd: `${ROOT}/notebooks/p/s1`,
  status: 'idle',
  messages: [
    {
      id: 'm',
      role: 'user',
      content: '',
      status: 'complete',
      eventIds: [],
      uploads: [
        {
          id: 'u',
          sessionId: 's1',
          name: 'f',
          originalName: 'f',
          path: `${ROOT}/uploads/f`,
          size: 1
        }
      ],
      createdAt: 0,
      updatedAt: 0
    }
  ],
  artifacts: [{ id: 'a', kind: 'managed-file', path: `${ROOT}/artifacts/p/s1/m/x.png` }],
  createdAt: 0,
  updatedAt: 0
}

describe('session data-path round-trip', () => {
  it('encodes data-root paths to $DATA and decodes against a new root', () => {
    const enc = encodeSessionDataPaths(session, ROOT)
    expect(enc.artifacts?.[0].path).toBe('$DATA/artifacts/p/s1/m/x.png')
    expect(enc.messages[0].uploads?.[0].path).toBe('$DATA/uploads/f')
    expect(enc.cwd).toBe('$DATA/notebooks/p/s1')

    const dec = decodeSessionDataPaths(enc, '/mnt/new')
    expect(dec.artifacts?.[0].path).toBe(join('/mnt/new', 'artifacts/p/s1/m/x.png'))
    expect(dec.messages[0].uploads?.[0].path).toBe(join('/mnt/new', 'uploads/f'))
    expect(dec.artifacts?.[0].fileUrl).toMatch(/^file:\/\/.*x\.png$/)
  })

  it('leaves an external cwd unchanged', () => {
    const s = { ...session, cwd: '/Users/x/project' }
    expect(encodeSessionDataPaths(s, ROOT).cwd).toBe('/Users/x/project')
  })
})
