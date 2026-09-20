import { createContext } from 'react'

// Search opens a matched text page; ordinary previews keep the default beginning-of-file position.
export const PreviewInitialPosition = createContext<
  | {
      offset: number
      startingLineNumber: number
    }
  | undefined
>(undefined)
