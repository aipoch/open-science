export type NotebookFileCallEffect = {
  kind: 'read' | 'write'
  position: number
  keywords: readonly string[]
  additionalPaths?: readonly { position: number; keywords: readonly string[] }[]
  // Formats whose conventional representation is one file; other formats need
  // header/companion evidence before a single path can represent the whole input.
  singleFileSuffixes?: readonly string[]
  // Added by path-based writers only; file handles retain their exact filename.
  appendedSuffix?: '.npy' | '.npz'
  pathOptional?: boolean
  // Some APIs accept a file path or an already loaded scientific value.
  inMemoryTypes?: readonly string[]
  inputForm?: 'paths' | 'lines'
}

export type PythonArgumentShape = 'none' | 'list' | 'scalar' | 'unknown'
