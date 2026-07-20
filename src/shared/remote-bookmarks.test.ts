import { describe, expect, it } from 'vitest'

import { readBookmarks, writeBookmarks } from './remote-fs'
import type { StoredSettings } from '../main/settings/types'
import { SETTINGS_FILE_VERSION } from './settings'

// Build a minimal StoredSettings fixture for round-trip testing.
const emptySettings = (): StoredSettings => ({
  version: SETTINGS_FILE_VERSION,
  providers: []
})

describe('readBookmarks / writeBookmarks', () => {
  it('returns an empty array when no bookmarks are stored', () => {
    const settings = emptySettings()
    expect(readBookmarks(settings, 'host-a')).toEqual([])
  })

  it('returns an empty array for an unknown provider_id', () => {
    const settings = writeBookmarks(emptySettings(), 'host-a', ['/home/user/projects'])
    expect(readBookmarks(settings, 'host-b')).toEqual([])
  })

  it('round-trips a list of bookmarks for a provider', () => {
    const folders = ['/home/user/data', '/scratch/results']
    const settings = writeBookmarks(emptySettings(), 'host-a', folders)
    expect(readBookmarks(settings, 'host-a')).toEqual(folders)
  })

  it('stores bookmarks independently per provider_id', () => {
    let settings = emptySettings()
    settings = writeBookmarks(settings, 'host-a', ['/a/one'])
    settings = writeBookmarks(settings, 'host-b', ['/b/two', '/b/three'])

    expect(readBookmarks(settings, 'host-a')).toEqual(['/a/one'])
    expect(readBookmarks(settings, 'host-b')).toEqual(['/b/two', '/b/three'])
  })

  it('overwrites existing bookmarks for a provider', () => {
    let settings = emptySettings()
    settings = writeBookmarks(settings, 'host-a', ['/old'])
    settings = writeBookmarks(settings, 'host-a', ['/new1', '/new2'])

    expect(readBookmarks(settings, 'host-a')).toEqual(['/new1', '/new2'])
  })

  it('writing an empty array clears bookmarks for a provider', () => {
    let settings = emptySettings()
    settings = writeBookmarks(settings, 'host-a', ['/folder'])
    settings = writeBookmarks(settings, 'host-a', [])

    expect(readBookmarks(settings, 'host-a')).toEqual([])
  })

  it('does not mutate the input settings object', () => {
    const original = emptySettings()
    const original_str = JSON.stringify(original)
    writeBookmarks(original, 'host-a', ['/data'])
    expect(JSON.stringify(original)).toBe(original_str)
  })
})
