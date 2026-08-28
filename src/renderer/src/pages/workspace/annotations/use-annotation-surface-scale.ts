import { useCallback, useContext, useSyncExternalStore } from 'react'
import { Context } from 'react-zoom-pan-pinch'

/**
 * The CSS scale the surrounding zoom wrapper currently applies to the
 * annotation surface. Image markers counter-scale with it so their
 * on-screen size stays constant while they stay pinned to normalized
 * image coordinates. Surfaces rendered outside a zoom wrapper (unit
 * tests, unzoomed hosts) read a scale of 1.
 */
const useAnnotationSurfaceScale = (): number => {
  const zoom = useContext(Context)
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) =>
      zoom ? zoom.onChange(() => onStoreChange()) : () => undefined,
    [zoom]
  )
  const getSnapshot = useCallback((): number => zoom?.state.scale ?? 1, [zoom])
  return useSyncExternalStore(subscribe, getSnapshot, () => 1)
}

export { useAnnotationSurfaceScale }
