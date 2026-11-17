import { describe, expect, it } from 'vitest'

import { PPTX_EDIT_MAX_OPERATIONS, type PptxOperation } from '../../../../../shared/pptx-edit'
import {
  canPushPptxOperation,
  EMPTY_PPTX_EDIT_STATE,
  isPptxEditDirty,
  pushOperation,
  pushOperations,
  redoOperation,
  undoOperation
} from './pptx-edit-state'

const del = (shapeId: number): PptxOperation => ({ op: 'deleteShape', slideId: 256, shapeId })

describe('pptx edit state', () => {
  it('is clean until an operation is pushed', () => {
    expect(isPptxEditDirty(EMPTY_PPTX_EDIT_STATE)).toBe(false)
    expect(isPptxEditDirty(pushOperation(EMPTY_PPTX_EDIT_STATE, del(1)))).toBe(true)
  })

  it('undoes and redoes in order and clears redo on a new operation', () => {
    let state = pushOperation(pushOperation(EMPTY_PPTX_EDIT_STATE, del(1)), del(2))
    state = undoOperation(state)
    expect(state.operations).toEqual([del(1)])
    expect(redoOperation(state).operations).toEqual([del(1), del(2)])
    expect(pushOperation(state, del(3)).redo).toEqual([])
  })

  it('ignores undo and redo on empty stacks', () => {
    expect(undoOperation(EMPTY_PPTX_EDIT_STATE)).toBe(EMPTY_PPTX_EDIT_STATE)
    expect(redoOperation(EMPTY_PPTX_EDIT_STATE)).toBe(EMPTY_PPTX_EDIT_STATE)
  })

  it('stops accepting operations at the schema limit', () => {
    const full = {
      operations: Array.from({ length: PPTX_EDIT_MAX_OPERATIONS }, (_, i) => del(i)),
      redo: []
    }
    expect(canPushPptxOperation(full)).toBe(false)
    expect(pushOperation(full, del(999))).toBe(full)
  })

  it('pushes a batch as separate undo steps and rejects a batch over the limit', () => {
    const undone = undoOperation(pushOperation(EMPTY_PPTX_EDIT_STATE, del(1)))
    const state = pushOperations(undone, [del(2), del(3)])
    expect(state).toEqual({ operations: [del(2), del(3)], redo: [] })
    expect(undoOperation(state).operations).toEqual([del(2)])
    expect(pushOperations(state, [])).toBe(state)
    const nearlyFull = {
      operations: Array.from({ length: PPTX_EDIT_MAX_OPERATIONS - 1 }, (_, index) => del(index)),
      redo: []
    }
    expect(pushOperations(nearlyFull, [del(998), del(999)])).toBe(nearlyFull)
  })
})
