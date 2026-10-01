import { createContext } from 'react'

// Position changes affect only the number cells, not each reference's entire row.
export const LiteratureRowNumbers = createContext<ReadonlyMap<string, number>>(new Map())
