import { useEffect, useState } from 'react'

type YearFilterState = Readonly<{
  from: string
  to: string
  draftFrom: string
  draftTo: string
  invalid: boolean
  setDraftFrom: (value: string) => void
  setDraftTo: (value: string) => void
  clear: () => void
}>

// Keep drafts and scheduling in the page owner so closing the popover cannot drop input.
const useLiteratureYearFilter = (onCommit: () => void): YearFilterState => {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [draftFrom, setDraftFrom] = useState('')
  const [draftTo, setDraftTo] = useState('')
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    if (draftFrom === from && draftTo === to) return
    const timeout = window.setTimeout(() => {
      const valid =
        [draftFrom, draftTo].every((year) => year === '' || /^\d{1,4}$/.test(year)) &&
        (!draftFrom || !draftTo || Number(draftFrom) <= Number(draftTo))
      setInvalid(!valid)
      if (valid) {
        setFrom(draftFrom)
        setTo(draftTo)
        onCommit()
      }
    }, 400)
    return () => window.clearTimeout(timeout)
  }, [draftFrom, draftTo, from, onCommit, to])

  return {
    from,
    to,
    draftFrom,
    draftTo,
    invalid: (draftFrom !== from || draftTo !== to) && invalid,
    setDraftFrom,
    setDraftTo,
    clear: (): void => {
      setFrom('')
      setTo('')
      setDraftFrom('')
      setDraftTo('')
      setInvalid(false)
    }
  }
}

export { useLiteratureYearFilter, type YearFilterState }
