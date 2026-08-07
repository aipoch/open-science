import { useEffect, useRef } from 'react'

import type { DecodedTiffPage } from '../tiff-preview-types'

const TiffCanvas = ({
  page,
  name,
  fit = 'contain',
  onError
}: {
  page: DecodedTiffPage
  name: string
  fit?: 'contain' | 'cover' | 'intrinsic'
  onError: (error: Error) => void
}): React.JSX.Element => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    try {
      const context = canvas?.getContext('2d')
      if (!canvas || !context) throw new Error('TIFF canvas is unavailable')

      canvas.width = page.width
      canvas.height = page.height
      const imageData = context.createImageData(page.width, page.height)
      imageData.data.set(page.rgba)
      context.putImageData(imageData, 0, 0)
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)))
    }
  }, [onError, page])

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={name}
      className={
        fit === 'cover'
          ? 'size-full object-cover object-top'
          : fit === 'intrinsic'
            ? 'block h-auto max-h-full w-auto max-w-full object-contain'
            : 'size-full object-contain'
      }
    />
  )
}

export { TiffCanvas }
