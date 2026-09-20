import { Suspense, useState, type ReactNode } from 'react'

// Defer presentation code until it is needed, then keep its owner mounted so close animations,
// nested confirmations, and local state follow the same lifecycle as an eagerly loaded owner.
export function DeferredPresentationOwner({
  active,
  children
}: {
  active: boolean
  children: (active: boolean) => ReactNode
}): React.JSX.Element | null {
  const [hasActivated, setHasActivated] = useState(active)
  if (active && !hasActivated) setHasActivated(true)

  return active || hasActivated ? <Suspense fallback={null}>{children(active)}</Suspense> : null
}
