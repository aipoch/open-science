import { Fragment } from 'react'

// Render `text` with the characters at `positions` (indices produced by fuzzyScore) emphasized, so the
// user can see why a fuzzy match ranked. Positions must be sorted ascending; anything out of range is
// ignored. With no positions this is just the plain text.
export const HighlightedText = ({
  text,
  positions
}: {
  text: string
  positions: number[]
}): React.JSX.Element => {
  if (positions.length === 0) return <>{text}</>

  const hit = new Set(positions)
  const segments: React.JSX.Element[] = []
  let run = ''
  let runIsHit = hit.has(0)

  const flush = (endExclusive: number): void => {
    if (run.length === 0) return
    segments.push(
      runIsHit ? (
        <mark
          key={endExclusive}
          className="bg-transparent font-semibold text-inherit underline decoration-1 underline-offset-2"
        >
          {run}
        </mark>
      ) : (
        <Fragment key={endExclusive}>{run}</Fragment>
      )
    )
    run = ''
  }

  for (let i = 0; i < text.length; i++) {
    const isHit = hit.has(i)
    if (isHit !== runIsHit) {
      flush(i)
      runIsHit = isHit
    }
    run += text[i]
  }
  flush(text.length)

  return <>{segments}</>
}
