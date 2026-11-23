import { useRef, useState } from 'react'

export type ProviderStepOperation = {
  pending: boolean
  begin(): boolean
  finish(): void
}

/** Keep operations scoped to the wizard so returning still waits for pending validation. */
export function useProviderStepOperation(): ProviderStepOperation {
  const [pending, setPending] = useState(false)
  const inFlight = useRef(false)

  return {
    pending,
    begin(): boolean {
      if (inFlight.current) return false
      inFlight.current = true
      setPending(true)
      return true
    },
    finish(): void {
      inFlight.current = false
      setPending(false)
    }
  }
}
