import { useState } from 'react'
import { BookOpen } from 'lucide-react'

import { loadedCovers } from './use-case-cover-cache'

export const UseCaseCover = ({ src }: { src: string }): React.JSX.Element => {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>(() =>
    loadedCovers.has(src) ? 'loaded' : 'loading'
  )
  return (
    <>
      <div
        aria-hidden="true"
        className={`absolute inset-0 flex items-center justify-center overflow-hidden bg-linear-to-br from-primary/10 via-bg-100 to-bg-200 transition-opacity duration-200 motion-reduce:transition-none ${status === 'loaded' ? 'opacity-0' : 'opacity-100'}`}
      >
        <div className="absolute -right-8 -top-12 size-44 rounded-full border border-primary/10" />
        <div className="absolute -bottom-16 -left-8 size-48 rounded-full border border-primary/10" />
        <div className={`relative ${status === 'loading' ? 'motion-safe:animate-pulse' : ''}`}>
          <div className="absolute inset-0 rotate-[-8deg] rounded-xl border border-primary/15 bg-primary/5" />
          <div className="relative flex h-24 w-20 flex-col items-center justify-center gap-3 rounded-xl border border-border/70 bg-background/80 shadow-sm">
            <BookOpen className="size-7 text-primary/60" strokeWidth={1.25} />
            <div className="flex w-10 flex-col items-center gap-1.5">
              <span className="h-1 w-full rounded-full bg-primary/15" />
              <span className="h-1 w-7 rounded-full bg-primary/10" />
            </div>
          </div>
        </div>
      </div>
      <img
        src={src}
        alt=""
        loading={loadedCovers.has(src) ? 'eager' : 'lazy'}
        onLoad={() => {
          loadedCovers.add(src)
          setStatus('loaded')
        }}
        onError={() => setStatus('error')}
        className={`relative h-full w-full object-contain transition-opacity duration-200 motion-reduce:transition-none ${status === 'loaded' ? 'opacity-100' : 'opacity-0'}`}
      />
    </>
  )
}
