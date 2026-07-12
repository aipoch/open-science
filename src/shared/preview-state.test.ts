import { describe, expect, it } from 'vitest'

import {
  createEmptyPersistedPreviewState,
  normalizePersistedPreviewState,
  PREVIEW_STATE_VERSION
} from './preview-state'

// A complete, valid persisted item used as a base for building test inputs.
const validItem = {
  id: 'item-1',
  sessionId: 'session-1',
  title: 'Report',
  source: 'artifact',
  path: '/project/report.md',
  format: 'markdown',
  name: 'report.md'
}

// Builds a copy of validItem without the given key, for exercising the optional/default branches.
const validItemWithout = (key: keyof typeof validItem): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...validItem }
  delete copy[key]
  return copy
}

describe('createEmptyPersistedPreviewState', () => {
  it('produces a collapsed, empty, versioned state', () => {
    const state = createEmptyPersistedPreviewState()

    expect(state).toEqual({
      version: PREVIEW_STATE_VERSION,
      panelState: 'collapsed',
      items: []
    })
    // The canonical empty state never carries an active item.
    expect(state.activeItemId).toBeUndefined()
  })
})

// sanitizePreviewFileItem is not exported, so its behavior is exercised through the items array
// of normalizePersistedPreviewState.
describe('normalizePersistedPreviewState item sanitization', () => {
  it('keeps a fully valid item and preserves its source', () => {
    const state = normalizePersistedPreviewState({ items: [validItem] })

    expect(state.items).toEqual([validItem])
  })

  it('drops items missing any of id, sessionId, path, or name', () => {
    const state = normalizePersistedPreviewState({
      items: [
        { ...validItem, id: undefined },
        { ...validItem, sessionId: undefined },
        { ...validItem, path: undefined },
        { ...validItem, name: undefined }
      ]
    })

    expect(state.items).toEqual([])
  })

  it('drops items whose required fields are empty strings', () => {
    // Empty strings are falsy, so they fail the id/sessionId/path/name guard.
    const state = normalizePersistedPreviewState({ items: [{ ...validItem, id: '' }] })

    expect(state.items).toEqual([])
  })

  it('drops non-record items', () => {
    const state = normalizePersistedPreviewState({ items: [null, 'string', 42, [], validItem] })

    expect(state.items).toEqual([validItem])
  })

  it('defaults title to name when title is missing', () => {
    const state = normalizePersistedPreviewState({ items: [validItemWithout('title')] })

    expect(state.items[0]?.title).toBe(validItem.name)
  })

  it('defaults format to "unknown" when format is missing', () => {
    const state = normalizePersistedPreviewState({ items: [validItemWithout('format')] })

    expect(state.items[0]?.format).toBe('unknown')
  })

  it('omits source when it is absent', () => {
    const state = normalizePersistedPreviewState({ items: [validItemWithout('source')] })

    expect(state.items[0]).not.toHaveProperty('source')
  })

  it('keeps source when it is present', () => {
    const state = normalizePersistedPreviewState({ items: [{ ...validItem, source: 'upload' }] })

    expect(state.items[0]?.source).toBe('upload')
  })

  it('ignores non-string field values, falling back to defaults or dropping the item', () => {
    // A non-string title falls back to name; a non-string path fails the guard and drops the item.
    const stringTitle = normalizePersistedPreviewState({ items: [{ ...validItem, title: 123 }] })
    const badPath = normalizePersistedPreviewState({ items: [{ ...validItem, path: 123 }] })

    expect(stringTitle.items[0]?.title).toBe(validItem.name)
    expect(badPath.items).toEqual([])
  })
})

describe('normalizePersistedPreviewState top-level normalization', () => {
  it('returns the empty state for non-object input', () => {
    const empty = createEmptyPersistedPreviewState()

    expect(normalizePersistedPreviewState(null)).toEqual(empty)
    expect(normalizePersistedPreviewState(undefined)).toEqual(empty)
    expect(normalizePersistedPreviewState('string')).toEqual(empty)
    expect(normalizePersistedPreviewState(42)).toEqual(empty)
    // Arrays are records to typeof but are explicitly rejected by isRecord.
    expect(normalizePersistedPreviewState([validItem])).toEqual(empty)
  })

  it('treats a missing or non-array items field as no items', () => {
    expect(normalizePersistedPreviewState({}).items).toEqual([])
    expect(normalizePersistedPreviewState({ items: 'nope' }).items).toEqual([])
  })

  it('always stamps the current version', () => {
    expect(normalizePersistedPreviewState({ items: [validItem] }).version).toBe(
      PREVIEW_STATE_VERSION
    )
  })

  it('coerces panelState to "collapsed" unless it is exactly "open"', () => {
    expect(normalizePersistedPreviewState({ panelState: 'open' }).panelState).toBe('open')
    expect(normalizePersistedPreviewState({ panelState: 'collapsed' }).panelState).toBe('collapsed')
    expect(normalizePersistedPreviewState({ panelState: 'anything' }).panelState).toBe('collapsed')
    expect(normalizePersistedPreviewState({ panelState: 42 }).panelState).toBe('collapsed')
    expect(normalizePersistedPreviewState({}).panelState).toBe('collapsed')
  })

  it('keeps activeItemId when it points at a surviving item', () => {
    const state = normalizePersistedPreviewState({
      items: [validItem],
      activeItemId: validItem.id
    })

    expect(state.activeItemId).toBe(validItem.id)
  })

  it('drops activeItemId when its item was filtered out', () => {
    // The active item is invalid (missing path) and gets dropped, so the id must not survive.
    const state = normalizePersistedPreviewState({
      items: [{ ...validItem, path: undefined }],
      activeItemId: validItem.id
    })

    expect(state.items).toEqual([])
    expect(state.activeItemId).toBeUndefined()
  })

  it('drops activeItemId that matches no item', () => {
    const state = normalizePersistedPreviewState({
      items: [validItem],
      activeItemId: 'nonexistent'
    })

    expect(state.activeItemId).toBeUndefined()
  })

  it('ignores a non-string activeItemId', () => {
    const state = normalizePersistedPreviewState({ items: [validItem], activeItemId: 123 })

    expect(state.activeItemId).toBeUndefined()
  })
})
