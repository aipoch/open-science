import { useMemo } from 'react'
import { findSearchMatches } from '../../../../shared/search-text'

export const SearchHighlight = ({
  text,
  query
}: {
  text: string
  query: string
}): React.JSX.Element => {
  const matches = useMemo(() => findSearchMatches(text, query), [text, query])
  return (
    <>
      {matches.map(({ start, end }, index) => {
        const before = text.slice(matches[index - 1]?.end ?? 0, start)
        return (
          <span key={start}>
            {before}
            <mark data-search-match={index} className="search-match">
              {text.slice(start, end)}
            </mark>
          </span>
        )
      })}
      {text.slice(matches.at(-1)?.end ?? 0)}
    </>
  )
}
