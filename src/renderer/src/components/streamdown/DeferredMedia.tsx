import { createContext, useContext, useState, type ComponentProps, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ExtraProps } from 'streamdown'

// Approval is local to this rendered media element, and bound to the complete URL set. A streaming
// replacement or added poster/source must never inherit consent for a different request.
const MediaUrls = createContext<readonly string[]>([])
type MediaNode = NonNullable<ExtraProps['node']>
const remoteUrls = (node?: MediaNode): string[] => {
  if (!node) return []
  const urls: string[] = []
  for (const key of ['src', 'poster']) {
    const value = node.properties[key]
    if (typeof value !== 'string' || !value) continue
    if (/^(blob:|data:(?:image|audio|video)\/)/i.test(value)) continue
    try {
      const url = new URL(value, window.location.href)
      if (url.protocol === 'http:' || url.protocol === 'https:') urls.push(url.href)
    } catch {
      /* Streamdown already filters unusable URLs. */
    }
  }
  for (const child of node.children) {
    if (child.type === 'element') urls.push(...remoteUrls(child))
  }
  return [...new Set(urls)]
}

const MediaGate = ({
  node,
  alt,
  children
}: ExtraProps & { alt?: string; children: ReactNode }): ReactNode => {
  const { t } = useTranslation()
  const urls = remoteUrls(node)
  const identity = JSON.stringify(urls)
  const [approved, setApproved] = useState<string>()
  if (urls.length && approved !== identity) {
    const domains = [...new Set(urls.map((url) => new URL(url).host))].join(', ')
    return (
      <button
        type="button"
        data-deferred-media=""
        className="my-1 inline-flex max-w-full flex-col items-start rounded-md border px-3 py-2 text-left text-sm"
        title={urls.join('\n')}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setApproved(identity)
        }}
      >
        {alt && <span>{alt}</span>}
        <span>{t('Load media from {{domains}}', { domains })}</span>
      </button>
    )
  }
  return <MediaUrls.Provider value={urls}>{children}</MediaUrls.Provider>
}

const DeferredImage = ({
  node,
  src,
  alt,
  width,
  height,
  title
}: ComponentProps<'img'> & ExtraProps): ReactNode => (
  <MediaGate node={node} alt={alt}>
    <img
      src={src}
      alt={alt ?? ''}
      width={width}
      height={height}
      title={title}
      referrerPolicy="no-referrer"
      className="max-w-full rounded-lg"
      data-streamdown="image"
    />
  </MediaGate>
)
const DeferredVideo = ({
  node,
  src,
  poster,
  width,
  height,
  children
}: ComponentProps<'video'> & ExtraProps): ReactNode => (
  <MediaGate node={node}>
    <video
      src={src}
      poster={poster}
      width={width}
      height={height}
      controls
      preload="none"
      playsInline
      className="max-w-full"
    >
      {children}
    </video>
  </MediaGate>
)
const DeferredAudio = ({
  node,
  src,
  children
}: ComponentProps<'audio'> & ExtraProps): ReactNode => (
  <MediaGate node={node}>
    <audio src={src} controls preload="none">
      {children}
    </audio>
  </MediaGate>
)
const ApprovedSource = ({ node, src, type }: ComponentProps<'source'> & ExtraProps): ReactNode => {
  const approved = useContext(MediaUrls)
  return remoteUrls(node).every((url) => approved.includes(url)) ? (
    <source src={src} type={type} />
  ) : null
}
const ApprovedTrack = ({
  node,
  src,
  kind,
  srcLang,
  label,
  default: isDefault
}: ComponentProps<'track'> & ExtraProps): ReactNode => {
  const approved = useContext(MediaUrls)
  return remoteUrls(node).every((url) => approved.includes(url)) ? (
    <track src={src} kind={kind} srcLang={srcLang} label={label} default={isDefault} />
  ) : null
}

// Keep SVG chart references local. Do not turn an SVG subtree into an embedded remote document.
const LocalSvgUse = ({
  href,
  x,
  y,
  width,
  height
}: ComponentProps<'use'> & ExtraProps): ReactNode =>
  href?.startsWith('#') ? <use href={href} x={x} y={y} width={width} height={height} /> : null

export { DeferredImage, DeferredVideo, DeferredAudio, ApprovedSource, ApprovedTrack, LocalSvgUse }
