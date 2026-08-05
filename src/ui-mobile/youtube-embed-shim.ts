/**
 * YouTube "lite embeds". WKWebView never attaches a Referer to iframe
 * navigations from locally served pages, and YouTube refuses referer-less
 * embed loads with player Error 153 — verified against capacitor://,
 * https://localhost and https://zennotes.app webview origins. The desktop
 * fixes this by injecting `Referer: https://zennotes.app/` in its Electron
 * main process, which has no WKWebView equivalent. Vimeo doesn't
 * referer-gate, so its player is left alone.
 *
 * Each YouTube iframe app-core drops into `.zen-embed-frame` is swapped for a
 * poster + play-button card that opens the video in the YouTube app / Safari
 * (universal link). Applies at every width — iPad has the same WebKit
 * limitation. The video title is fetched best-effort from YouTube's oEmbed
 * endpoint through CapacitorHttp (native, no CORS), mirroring how bookmark
 * cards fetch their metadata (bridge/link-metadata.ts).
 */
import { useEffect } from 'react'
import { CapacitorHttp } from '@capacitor/core'

const IFRAME_SELECTOR = 'iframe[src^="https://www.youtube-nocookie.com/embed/"]'

const PLAY_SVG =
  '<svg viewBox="0 0 68 48" aria-hidden="true">' +
  '<path d="M66.52 7.74a8 8 0 0 0-5.63-5.66C55.94.86 34 .86 34 .86s-21.94 0-26.89 1.22a8 8 0 0 0-5.63 5.66A83.6 83.6 0 0 0 .36 24a83.6 83.6 0 0 0 1.12 16.26 8 8 0 0 0 5.63 5.66C12.06 47.14 34 47.14 34 47.14s21.94 0 26.89-1.22a8 8 0 0 0 5.63-5.66A83.6 83.6 0 0 0 67.64 24a83.6 83.6 0 0 0-1.12-16.26z" fill="#f03"/>' +
  '<path d="M45 24 27 14v20z" fill="#fff"/>' +
  '</svg>'

// One fetch per video per session, shared across re-renders (embeds re-mount
// whenever the note re-renders).
const titleCache = new Map<string, Promise<string | null>>()

function fetchTitle(videoId: string): Promise<string | null> {
  let p = titleCache.get(videoId)
  if (!p) {
    const watch = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
    p = CapacitorHttp.get({
      url: `https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json`,
      connectTimeout: 6000,
      readTimeout: 6000
    })
      .then((res) => {
        const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data
        const title = (data as { title?: unknown } | null)?.title
        return typeof title === 'string' && title ? title : null
      })
      .catch(() => null)
    titleCache.set(videoId, p)
  }
  return p
}

function buildCard(videoId: string, start: string | null): HTMLButtonElement {
  const id = encodeURIComponent(videoId)
  const watchUrl = `https://www.youtube.com/watch?v=${id}${start ? `&t=${start}s` : ''}`

  const card = document.createElement('button')
  card.type = 'button'
  card.className = 'zn-yt-lite'
  card.title = watchUrl
  card.setAttribute('aria-label', 'Watch on YouTube')

  const poster = document.createElement('img')
  poster.alt = ''
  poster.loading = 'lazy'
  // hq720 is sharp but missing for some videos; hqdefault always exists.
  poster.src = `https://i.ytimg.com/vi/${id}/hq720.jpg`
  poster.onerror = () => {
    poster.onerror = null
    poster.src = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
  }
  card.appendChild(poster)

  const title = document.createElement('span')
  title.className = 'zn-yt-lite-title'
  card.appendChild(title)
  void fetchTitle(videoId).then((t) => {
    if (t && card.isConnected) title.textContent = t
  })

  const play = document.createElement('span')
  play.className = 'zn-yt-lite-play'
  play.innerHTML = PLAY_SVG
  card.appendChild(play)

  // Open the video ourselves and stop the bubble so the tap is never also
  // treated as a "reveal source" click by the live editor (same trick as the
  // bookmark cards in app-core).
  card.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    window.open(watchUrl, '_blank', 'noopener,noreferrer')
  })
  return card
}

function swapOne(iframe: HTMLIFrameElement): void {
  let src: URL
  try {
    src = new URL(iframe.src)
  } catch {
    return
  }
  const videoId = src.pathname.split('/').pop()
  if (!videoId) return
  iframe.replaceWith(buildCard(decodeURIComponent(videoId), src.searchParams.get('start')))
}

function swapAll(root: ParentNode): void {
  for (const iframe of root.querySelectorAll<HTMLIFrameElement>(IFRAME_SELECTOR)) {
    swapOne(iframe)
  }
}

export function useYouTubeLiteEmbeds(): void {
  useEffect(() => {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node instanceof HTMLIFrameElement && node.matches(IFRAME_SELECTOR)) {
            swapOne(node)
          } else if (node instanceof HTMLElement) {
            swapAll(node)
          }
        }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    swapAll(document)
    return () => observer.disconnect()
  }, [])
}
