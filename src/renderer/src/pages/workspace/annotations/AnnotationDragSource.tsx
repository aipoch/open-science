import type { PropsWithChildren } from 'react'
import { TransferSourceContext, type SourceContext } from './use-annotation-drag'

export function AnnotationDragSource({
  children,
  ...source
}: PropsWithChildren<Omit<SourceContext, 'select'>>): React.JSX.Element {
  return <TransferSourceContext.Provider value={source}>{children}</TransferSourceContext.Provider>
}
