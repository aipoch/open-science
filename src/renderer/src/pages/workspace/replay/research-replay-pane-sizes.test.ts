import { describe, expect, it } from 'vitest'
import {
  getResearchReplayMinimumGroupWidth,
  getResearchReplayPaneMinimumWidth,
  RESEARCH_REPLAY_SEPARATOR_WIDTH,
  resizeResearchReplayPaneWidths,
  resolveResearchReplayPaneWidths
} from './research-replay-pane-sizes'

const panes = ['conversation', 'notebook', 'project', 'results']

describe('research replay pane widths', () => {
  it('retains 80 pixels of resize space per visible separator', () => {
    const minimum = panes.reduce((sum, id) => sum + getResearchReplayPaneMinimumWidth(id), 0)
    expect(getResearchReplayMinimumGroupWidth(panes)).toBe(minimum + 3 * 81)
    expect(getResearchReplayMinimumGroupWidth(['conversation', 'results'])).toBe(701)
    expect(getResearchReplayMinimumGroupWidth(['notebook'])).toBe(0)
    expect(getResearchReplayMinimumGroupWidth([])).toBe(0)
    const widths = resolveResearchReplayPaneWidths({
      mode: 'columns',
      visiblePaneIds: panes,
      availableWidth:
        getResearchReplayMinimumGroupWidth(panes) - 3 * RESEARCH_REPLAY_SEPARATOR_WIDTH
    })
    expect(Object.values(widths).reduce((sum, width) => sum + width, 0) - minimum).toBeCloseTo(240)
  })

  it('normalizes split defaults and persisted ratios without hidden panes taking width', () => {
    expect(
      resolveResearchReplayPaneWidths({
        mode: 'split',
        visiblePaneIds: ['conversation', 'results'],
        availableWidth: 1000
      })
    ).toEqual({ conversation: 350, results: expect.closeTo(650) })
    expect(
      resolveResearchReplayPaneWidths({
        mode: 'split',
        visiblePaneIds: ['conversation', 'notebook'],
        availableWidth: 1500,
        widths: { conversation: 2, notebook: 3, project: 100 }
      })
    ).toEqual({ conversation: 600, notebook: expect.closeTo(900) })
  })

  it('redistributes weights around minimum widths and fills the available panel space', () => {
    const widths = resolveResearchReplayPaneWidths({
      mode: 'columns',
      visiblePaneIds: panes,
      availableWidth: 1500,
      widths: { conversation: 1, notebook: 90, project: 1, results: 8 }
    })
    expect(widths).toEqual({ conversation: 300, notebook: 560, project: 320, results: 320 })
    expect(
      resolveResearchReplayPaneWidths({
        mode: 'split',
        visiblePaneIds: ['conversation', 'notebook'],
        availableWidth: 740
      })
    ).toEqual({ conversation: 300, notebook: 440 })
  })

  it('preserves minimum widths in a narrow multi-pane group and lets a single pane fit', () => {
    expect(
      resolveResearchReplayPaneWidths({
        mode: 'columns',
        visiblePaneIds: panes,
        availableWidth: 600
      })
    ).toEqual({ conversation: 300, notebook: 360, project: 320, results: 320 })
    expect(
      resolveResearchReplayPaneWidths({
        mode: 'tabs',
        visiblePaneIds: ['notebook'],
        availableWidth: 200
      })
    ).toEqual({ notebook: 200 })
    expect(
      resolveResearchReplayPaneWidths({
        mode: 'columns',
        visiblePaneIds: [],
        availableWidth: 600
      })
    ).toEqual({})
  })

  it('ignores invalid stored weights and avoids overflow when normalizing large weights', () => {
    expect(
      resolveResearchReplayPaneWidths({
        mode: 'split',
        visiblePaneIds: ['conversation', 'notebook'],
        availableWidth: 1000,
        widths: { conversation: Number.NaN, notebook: -1 }
      })
    ).toEqual({ conversation: 350, notebook: expect.closeTo(650) })
    expect(
      resolveResearchReplayPaneWidths({
        mode: 'columns',
        visiblePaneIds: ['conversation', 'notebook'],
        availableWidth: 1000,
        widths: { conversation: Number.MAX_VALUE, notebook: Number.MAX_VALUE }
      })
    ).toEqual({ conversation: 500, notebook: 500 })
  })
})

describe('research replay boundary resizing', () => {
  const paneWidths = { conversation: 400, notebook: 500, project: 400, results: 700 }

  it('changes only the adjacent visible pair and returns percentages', () => {
    expect(
      resizeResearchReplayPaneWidths({
        paneWidths,
        leftPaneId: 'notebook',
        rightPaneId: 'project',
        deltaPixels: 60
      })
    ).toEqual({ conversation: 20, notebook: expect.closeTo(28), project: 17, results: 35 })
    expect(paneWidths.notebook).toBe(500)
    expect(
      resizeResearchReplayPaneWidths({
        paneWidths: { conversation: 350, notebook: 0, project: 0, results: 650 },
        leftPaneId: 'conversation',
        rightPaneId: 'results',
        deltaPixels: 100
      })
    ).toEqual({ conversation: 45, notebook: 0, project: 0, results: expect.closeTo(55) })
  })

  it('clamps both directions at the pair minimum widths', () => {
    expect(
      resizeResearchReplayPaneWidths({
        paneWidths,
        leftPaneId: 'conversation',
        rightPaneId: 'notebook',
        deltaPixels: -Infinity
      })
    ).toEqual({ conversation: 15, notebook: 30, project: 20, results: 35 })
    expect(
      resizeResearchReplayPaneWidths({
        paneWidths,
        leftPaneId: 'conversation',
        rightPaneId: 'notebook',
        deltaPixels: Infinity
      })
    ).toEqual({ conversation: 27, notebook: 18, project: 20, results: 35 })
  })

  it('retains widths when a boundary is stale, nonadjacent, or has no valid delta', () => {
    for (const [leftPaneId, rightPaneId, deltaPixels] of [
      ['missing', 'notebook', 100],
      ['conversation', 'project', 100],
      ['conversation', 'notebook', Number.NaN]
    ] as const) {
      expect(
        resizeResearchReplayPaneWidths({ paneWidths, leftPaneId, rightPaneId, deltaPixels })
      ).toEqual({ conversation: 20, notebook: 25, project: 20, results: 35 })
    }
  })
})
