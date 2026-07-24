import { useState } from 'react'

// Keeps the last non-null payload available while a controlled Radix dialog plays its exit animation.
// The live value still decides whether the dialog is open; retained data is render-only and never
// flows back into the owning store or callback.
const useRetainedDialogValue = <T>(value: T | null | undefined): T | undefined => {
  const [retainedValue, setRetainedValue] = useState<T | undefined>(() => value ?? undefined)

  if (value != null && !Object.is(value, retainedValue)) {
    setRetainedValue(value)
    return value
  }

  return value ?? retainedValue
}

export { useRetainedDialogValue }
