import { createContext, useContext } from 'react'

import type { Bookmark, BookmarkTarget } from '../../../../../shared/bookmarks'

type BookmarkPort = Readonly<{
  scoped: boolean
  sessionId?: string
  available: boolean
  bookmarks: readonly Bookmark[]
  total: number
  loading: boolean
  loadError?: string
  retryLoad: () => void
  create: (id: string, target: BookmarkTarget, note: string) => Promise<Bookmark>
  updateNote: (id: string, note: string) => Promise<Bookmark>
  remove: (id: string) => Promise<boolean>
}>

const unavailableError = (): Error => new Error('Bookmarks require a persisted Session.')

const unavailablePort: BookmarkPort = {
  scoped: false,
  available: false,
  bookmarks: [],
  total: 0,
  loading: false,
  retryLoad: () => {},
  create: () => Promise.reject(unavailableError()),
  updateNote: () => Promise.reject(unavailableError()),
  remove: () => Promise.reject(unavailableError())
}

const BookmarksContext = createContext<BookmarkPort>(unavailablePort)

const useBookmarks = (): BookmarkPort => useContext(BookmarksContext)

export { BookmarksContext, unavailableError, useBookmarks }
export type { BookmarkPort }
