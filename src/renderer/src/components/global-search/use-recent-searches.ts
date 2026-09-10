import { useState } from 'react'

const STORAGE_KEY = 'open-science-recent-searches'
const readRecentSearches = (): string[] => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(value)
      ? value
          .filter((entry): entry is string => typeof entry === 'string' && entry.length <= 200)
          .slice(0, 5)
      : []
  } catch {
    return []
  }
}

export const useRecentSearches = (): {
  recentSearches: string[]
  rememberSearch: (query: string) => void
} => {
  const [recentSearches, setRecentSearches] = useState(readRecentSearches)
  const rememberSearch = (query: string): void => {
    const value = query.trim()
    if (!value || value.length > 200) return
    const next = [value, ...recentSearches.filter((entry) => entry !== value)].slice(0, 5)
    setRecentSearches(next)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // Search remains available when browser storage is disabled.
    }
  }
  return { recentSearches, rememberSearch }
}
