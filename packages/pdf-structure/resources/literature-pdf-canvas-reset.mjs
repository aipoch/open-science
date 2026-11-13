/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { clearAllCache } from '@napi-rs/canvas'
// Release retired Skia surfaces after the renderer clears its owned mask canvas.
export function installPdfCanvasReset(factory) {
  const reset = factory.reset
  factory.reset = function (target, width, height) {
    const result = reset.call(this, target, width, height)
    clearAllCache()
    return result
  }
}
