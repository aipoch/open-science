import * as React from 'react'

// Portals retain this React scope even when mounted under document.body.
// Each modal advances by 20; its menus/tooltips use the intermediate +10 layer.
const OverlayLayerContext = React.createContext(40)
export const OverlayLayerProvider = OverlayLayerContext.Provider
export const useOverlayLayer = (): number => React.useContext(OverlayLayerContext)

// Lifecycle decisions stay above workspace portals, with the quit confirmation last.
export const desktopRecoveryLayer = 220
export const closeConfirmationLayer = 240
