import { useRef, useState } from 'react'

export type ProviderStepOperation = {
  pending: boolean
  begin(): boolean
  finish(): void
}

/** 由引导页持有操作状态，返回后仍需等待上一轮验证结束。 */
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
