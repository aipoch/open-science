// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import {
  getLastOpenedProjectId,
  recordLastOpenedProject,
  resolveCustomizeProjectId
} from './last-opened-project'

// Last-opened persistence mirrors the theme preference: a renderer-local durable value that survives
// application restart (Chromium backs localStorage from the app userData dir). The chat entry always
// re-validates the stored id against the live project catalog before navigating, so a deleted project
// falls back to the newest-existing project instead of a dead link.
describe('last-opened-project', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('returns undefined when nothing has been recorded', () => {
    expect(getLastOpenedProjectId()).toBeUndefined()
  })

  it('records and reads back a project id', () => {
    recordLastOpenedProject('climate-models')
    expect(getLastOpenedProjectId()).toBe('climate-models')
  })

  it('survives a simulated restart by persisting in localStorage', () => {
    recordLastOpenedProject('climate-models')
    // Simulate a fresh module read by re-reading the same localStorage the app userData backs.
    expect(window.localStorage.getItem('open-science:last-opened-project')).toBe('climate-models')
    // A re-import / re-read in a new session sees the persisted value.
    expect(getLastOpenedProjectId()).toBe('climate-models')
  })

  describe('resolveCustomizeProjectId', () => {
    it('returns undefined with zero projects', () => {
      expect(resolveCustomizeProjectId([])).toBeUndefined()
    })

    it('selects the last-opened project when it still exists', () => {
      const projects = [
        { id: 'a', updatedAt: 1 },
        { id: 'b', updatedAt: 2 },
        { id: 'climate-models', updatedAt: 3 }
      ]
      recordLastOpenedProject('a')
      expect(resolveCustomizeProjectId(projects)).toBe('a')
    })

    it('falls back to the newest-existing project when the reference is missing', () => {
      const projects = [
        { id: 'a', updatedAt: 1 },
        { id: 'newest', updatedAt: 99 },
        { id: 'c', updatedAt: 3 }
      ]
      recordLastOpenedProject('deleted-id')
      expect(resolveCustomizeProjectId(projects)).toBe('newest')
    })

    it('falls back to the newest project when no last-opened reference exists', () => {
      const projects = [
        { id: 'a', updatedAt: 1 },
        { id: 'b', updatedAt: 50 },
        { id: 'c', updatedAt: 3 }
      ]
      expect(resolveCustomizeProjectId(projects)).toBe('b')
    })

    it('selects the only project when exactly one exists', () => {
      expect(resolveCustomizeProjectId([{ id: 'solo', updatedAt: 7 }])).toBe('solo')
    })
  })
})
