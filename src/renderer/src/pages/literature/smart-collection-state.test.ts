import { expect, it } from 'vitest'
import { createSmartCollectionState } from './smart-collection-state'
import type { SmartCollectionView } from '../../../../shared/literature-smart-collections'
const summary = (match: number): SmartCollectionView =>
  ({ counts: { match }, matches: match }) as SmartCollectionView
it('rejects reads from before and during a committed decision, including reverse returns', () => {
  const state = createSmartCollectionState()
  const old = state.beginRead()
  state.beginWrite()
  const during = state.beginRead()
  const saved = summary(1)
  state.finishWrite(saved)
  expect(state.acceptRead(old, summary(0))).toBe(false)
  expect(state.acceptRead(during, summary(0))).toBe(false)
  expect(state.getSnapshot()).toBe(saved)
  const first = state.beginRead()
  const second = state.beginRead()
  expect(state.acceptRead(second, summary(2))).toBe(true)
  expect(state.acceptRead(first, summary(1))).toBe(false)
  expect(state.getSettledSnapshot()?.matches).toBe(2)
})
it('keeps table counts stable while publishing live progress, then settles atomically', () => {
  const state = createSmartCollectionState()
  const saved = summary(1)
  state.finishWrite(saved)
  const live = { ...summary(3), run: { state: 'running' } } as SmartCollectionView
  state.acceptRead(state.beginRead(), live)
  expect(state.getSnapshot()).toBe(live)
  expect(state.getSettledSnapshot()).toBe(saved)
  state.acceptRead(state.beginRead(), summary(4))
  expect(state.getSettledSnapshot()).toBe(state.getSnapshot())
})
