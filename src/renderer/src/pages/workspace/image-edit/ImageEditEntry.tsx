import type { ReactNode } from 'react'

export function ImageEditEntry({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="relative size-full">{children}</div>
}
