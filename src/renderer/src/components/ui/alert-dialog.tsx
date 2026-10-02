import * as React from 'react'
import { AlertDialog as Primitive } from 'radix-ui'
import { OverlayLayerProvider, useOverlayLayer } from './overlay-layer'

function Root(props: React.ComponentProps<typeof Primitive.Root>): React.JSX.Element {
  const parentLayer = useOverlayLayer()
  return (
    <OverlayLayerProvider value={parentLayer + 20}>
      <Primitive.Root {...props} />
    </OverlayLayerProvider>
  )
}
function Overlay({
  style,
  ...props
}: React.ComponentProps<typeof Primitive.Overlay>): React.JSX.Element {
  const layer = useOverlayLayer()
  return <Primitive.Overlay {...props} style={{ ...style, zIndex: layer }} />
}
function Content({
  style,
  ...props
}: React.ComponentProps<typeof Primitive.Content>): React.JSX.Element {
  const layer = useOverlayLayer()
  return <Primitive.Content {...props} style={{ ...style, zIndex: layer }} />
}
const { Trigger, Portal, Title, Description, Action, Cancel } = Primitive
export { Root, Overlay, Content, Trigger, Portal, Title, Description, Action, Cancel }
