import { describe, expect, it, vi } from 'vitest'
import {
  createResearchReplayLayoutPreferences,
  getResearchReplayVisiblePaneIds,
  normalizeResearchReplayLayoutPreferences,
  readResearchReplayLayoutPreferences,
  researchReplayLayoutWidthKey,
  updateResearchReplayPaneVisibility,
  writeResearchReplayLayoutPreferences
} from './research-replay-layout'

const panes = ['conversation', 'notebook', 'project', 'results']

describe('research replay layout preferences', () => {
  it('starts with conversation and Notebook, retaining an existing material selection', () => {
    const defaults = createResearchReplayLayoutPreferences(panes)
    expect(getResearchReplayVisiblePaneIds(defaults, panes)).toEqual(['conversation', 'notebook'])
    const project = createResearchReplayLayoutPreferences(panes, 'project')
    expect(getResearchReplayVisiblePaneIds(project, panes)).toEqual(['conversation', 'project'])
    expect(createResearchReplayLayoutPreferences(panes, 'conversation').rightMaterialId).toBe(
      'notebook'
    )
  })

  it('switches to columns when showing/hiding an individual pane and prevents hiding the last pane', () => {
    let state = createResearchReplayLayoutPreferences(panes)
    state = updateResearchReplayPaneVisibility(state, 'results', true, panes)
    expect(state.mode).toBe('columns')
    expect(state.visiblePaneIds).toEqual(['conversation', 'notebook', 'results'])
    state = updateResearchReplayPaneVisibility(state, 'conversation', false, panes)
    state = updateResearchReplayPaneVisibility(state, 'notebook', false, panes)
    expect(state.visiblePaneIds).toEqual(['results'])
    expect(updateResearchReplayPaneVisibility(state, 'results', false, panes)).toBe(state)
    expect(updateResearchReplayPaneVisibility(state, 'unknown', true, panes)).toBe(state)
    expect(
      updateResearchReplayPaneVisibility(state, 'conversation', true, panes).visiblePaneIds
    ).toEqual(['conversation', 'results'])
  })

  it('uses the current right material in split mode without discarding the columns preference', () => {
    const state = {
      ...createResearchReplayLayoutPreferences(panes),
      visiblePaneIds: panes,
      rightMaterialId: 'results'
    }
    expect(getResearchReplayVisiblePaneIds(state, panes)).toEqual(['conversation', 'results'])
    expect(getResearchReplayVisiblePaneIds({ ...state, mode: 'columns' }, panes)).toEqual(panes)
    expect(researchReplayLayoutWidthKey('split', ['conversation', 'notebook'])).not.toBe(
      researchReplayLayoutWidthKey('columns', ['conversation', 'notebook'])
    )
  })

  it('drops stale panels, invalid ratios and unrelated storage payloads', () => {
    const state = normalizeResearchReplayLayoutPreferences(
      {
        version: 1,
        mode: 'columns',
        rightMaterialId: 'removed',
        visiblePaneIds: ['results', 'conversation', 'conversation', 'removed', 5],
        widthsByLayout: {
          'split:conversation,notebook': {
            conversation: 40,
            notebook: 60,
            secret: 'never persisted'
          },
          'columns:conversation,removed': { conversation: 60, removed: 40 },
          'columns:conversation,results': { conversation: Number.NaN, results: 50 },
          'columns:conversation': { conversation: -5 },
          'other:conversation': { conversation: 100 }
        },
        accessGrant: 'must not survive normalization'
      },
      panes
    )
    expect(state).toEqual({
      version: 1,
      mode: 'columns',
      rightMaterialId: 'notebook',
      visiblePaneIds: ['conversation', 'results'],
      widthsByLayout: { 'split:conversation,notebook': { conversation: 40, notebook: 60 } }
    })
    expect(normalizeResearchReplayLayoutPreferences({ version: 99 }, panes)).toEqual(
      createResearchReplayLayoutPreferences(panes)
    )
  })

  it('restores separate split/columns widths and remains usable when browser storage fails', () => {
    const saved = {
      ...createResearchReplayLayoutPreferences(panes),
      widthsByLayout: {
        'split:conversation,notebook': { conversation: 36, notebook: 64 },
        'columns:conversation,notebook': { conversation: 55, notebook: 45 }
      }
    }
    const storage = { getItem: vi.fn(() => JSON.stringify(saved)), setItem: vi.fn() }
    expect(readResearchReplayLayoutPreferences(storage, 'layout', panes)).toEqual(saved)
    writeResearchReplayLayoutPreferences(storage, 'layout', saved)
    expect(storage.setItem).toHaveBeenCalledWith('layout', JSON.stringify(saved))
    storage.getItem.mockImplementation(() => {
      throw new Error('Unavailable')
    })
    storage.setItem.mockImplementation(() => {
      throw new Error('Quota exceeded')
    })
    expect(readResearchReplayLayoutPreferences(storage, 'layout', panes)).toEqual(
      createResearchReplayLayoutPreferences(panes)
    )
    expect(() => writeResearchReplayLayoutPreferences(storage, 'layout', saved)).not.toThrow()
    expect(
      readResearchReplayLayoutPreferences(
        { ...storage, getItem: () => 'invalid JSON' },
        'layout',
        panes
      )
    ).toEqual(createResearchReplayLayoutPreferences(panes))
  })
})
