import { PPTX_EDIT_MAX_OPERATIONS, type PptxOperation } from '../../../../../shared/pptx-edit'

// The renderer owns only the operation list. Main replays it onto the pinned base version, so
// undo is popping the last operation and the dirty state is a non-empty list.
type PptxEditState = {
  operations: readonly PptxOperation[]
  redo: readonly PptxOperation[]
}

const EMPTY_PPTX_EDIT_STATE: PptxEditState = { operations: [], redo: [] }

const pushOperation = (state: PptxEditState, operation: PptxOperation): PptxEditState => {
  if (state.operations.length >= PPTX_EDIT_MAX_OPERATIONS) return state
  return { operations: [...state.operations, operation], redo: [] }
}

// A multi-field editor commits its changes as one replay; each change stays its own undo step.
const pushOperations = (
  state: PptxEditState,
  operations: readonly PptxOperation[]
): PptxEditState => {
  if (operations.length === 0) return state
  if (state.operations.length + operations.length > PPTX_EDIT_MAX_OPERATIONS) return state
  return { operations: [...state.operations, ...operations], redo: [] }
}

const undoOperation = (state: PptxEditState): PptxEditState => {
  const last = state.operations.at(-1)
  if (!last) return state
  return { operations: state.operations.slice(0, -1), redo: [...state.redo, last] }
}

const redoOperation = (state: PptxEditState): PptxEditState => {
  const next = state.redo.at(-1)
  if (!next) return state
  return { operations: [...state.operations, next], redo: state.redo.slice(0, -1) }
}

const isPptxEditDirty = (state: PptxEditState): boolean => state.operations.length > 0

const canPushPptxOperation = (state: PptxEditState): boolean =>
  state.operations.length < PPTX_EDIT_MAX_OPERATIONS

export {
  canPushPptxOperation,
  EMPTY_PPTX_EDIT_STATE,
  isPptxEditDirty,
  pushOperation,
  pushOperations,
  redoOperation,
  undoOperation
}
export type { PptxEditState }
