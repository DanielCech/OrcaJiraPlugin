// Jira Attachments panel: a gallery of the current issue's attachments, with an image viewer and a
// video player. This is an HTML panel (not "components") because only HTML frames may show
// blob: images and video. The frame has no network: the worker downloads each file with the
// Jira login and hands it over in base64 chunks (orca.plugin.request answers are capped at 1 MiB).
// No build step: Orca strips the types when it loads this file.
import type {} from 'orca/frame'
import type { AttachmentChunk, AttachmentInfo, JiraState } from './protocol'

type Download = { received: number; total: number }
type Loaded = { url: string; bytes: ArrayBuffer; mimeType: string }
type View = { kind: 'grid' } | { kind: 'viewer'; id: string }

const REQUEST_TIMEOUT_MS = 120_000
const THUMBNAIL_CONCURRENCY = 2
/** Images without a Jira thumbnail are shown in the grid at full size up to this size. */
const INLINE_IMAGE_MAX_BYTES = 1.5 * 1024 * 1024

let state: JiraState | null = null
let view: View = { kind: 'grid' }
let refreshing = false
/** Bumped when the issue changes, so downloads for the previous issue are dropped. */
let generation = 0
const thumbs = new Map<string, string | 'loading' | 'error'>()
const full = new Map<string, Loaded>()
const progress = new Map<string, Download>()
const failures = new Map<string, { message: string; tooLarge: boolean }>()
const unplayable = new Set<string>()

// ---------------------------------------------------------------- helpers

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: (Node | string | null | false | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
    } else if (key === 'className') {
      node.className = String(value)
    } else {
      node.setAttribute(key, value === true ? '' : String(value))
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    node.append(child)
  }
  return node
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function kindOf(a: AttachmentInfo): 'image' | 'video' | 'audio' | 'file' {
  const type = a.mimeType.toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  return 'file'
}

/** Chromium plays H.264 .mov files when told they are MP4. */
function playableType(mimeType: string): string {
  return mimeType === 'video/quicktime' ? 'video/mp4' : mimeType
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function attachments(): AttachmentInfo[] {
  return state?.issue && state.issue.key === state.key ? state.issue.attachments ?? [] : []
}

function byId(id: string): AttachmentInfo | undefined {
  return attachments().find((a) => a.id === id)
}

// ---------------------------------------------------------------- data

/** Pulls one attachment from the worker chunk by chunk. Retries when Orca's rate limit kicks in. */
async function fetchBytes(
  a: AttachmentInfo,
  kind: 'thumbnail' | 'content',
  onProgress?: (received: number, total: number) => void
): Promise<{ bytes: ArrayBuffer; mimeType: string }> {
  const mine = generation
  const parts: Uint8Array[] = []
  let offset = 0
  let total = a.size
  let mimeType = a.mimeType
  for (;;) {
    let chunk: AttachmentChunk
    try {
      chunk = await orca.plugin.request(
        'jira.attachment',
        { id: a.id, kind, offset },
        { timeoutMs: REQUEST_TIMEOUT_MS }
      )
    } catch (error) {
      const e = error as Error & { code?: string; retryAfterMs?: number }
      if (e.code === 'rate_limited') {
        await sleep(e.retryAfterMs ?? 2000)
        continue
      }
      throw e
    }
    if (mine !== generation) throw new Error('The issue changed.')
    if (!chunk.ok) throw Object.assign(new Error(chunk.error), { tooLarge: chunk.tooLarge === true })
    const bytes = decodeBase64(chunk.data)
    parts.push(bytes)
    offset = chunk.offset + bytes.length
    total = chunk.size
    mimeType = chunk.mimeType
    onProgress?.(offset, total)
    if (chunk.done) break
  }
  const merged = new Uint8Array(offset)
  let at = 0
  for (const part of parts) {
    merged.set(part, at)
    at += part.length
  }
  return { bytes: merged.buffer, mimeType }
}

let thumbQueue: AttachmentInfo[] = []
let thumbWorkers = 0

function queueThumbnails(): void {
  thumbQueue = attachments().filter(
    (a) =>
      !thumbs.has(a.id) &&
      (a.hasThumbnail || (kindOf(a) === 'image' && a.size <= INLINE_IMAGE_MAX_BYTES))
  )
  for (const a of thumbQueue) thumbs.set(a.id, 'loading')
  while (thumbWorkers < THUMBNAIL_CONCURRENCY && thumbQueue.length) {
    thumbWorkers++
    void runThumbnails()
  }
}

async function runThumbnails(): Promise<void> {
  try {
    for (let a = thumbQueue.shift(); a; a = thumbQueue.shift()) {
      const mine = generation
      try {
        const kind = a.hasThumbnail ? 'thumbnail' : 'content'
        const { bytes, mimeType } = await fetchBytes(a, kind)
        if (mine !== generation) continue
        thumbs.set(a.id, URL.createObjectURL(new Blob([bytes], { type: mimeType })))
      } catch {
        if (mine === generation) thumbs.set(a.id, 'error')
      }
      if (mine === generation) render()
    }
  } finally {
    thumbWorkers--
  }
}

async function loadFull(a: AttachmentInfo): Promise<void> {
  if (full.has(a.id) || progress.has(a.id)) return
  if (a.size > (state?.maxMediaBytes ?? Infinity)) {
    failures.set(a.id, {
      message: `${formatSize(a.size)} is more than the ${formatSize(state?.maxMediaBytes ?? 0)} limit set in Settings.`,
      tooLarge: true
    })
    render()
    return
  }
  const mine = generation
  failures.delete(a.id)
  progress.set(a.id, { received: 0, total: a.size })
  render()
  try {
    const { bytes, mimeType } = await fetchBytes(a, 'content', (received, total) => {
      progress.set(a.id, { received, total })
      updateProgress(a.id)
    })
    if (mine !== generation) return
    const url = URL.createObjectURL(new Blob([bytes], { type: playableType(mimeType) }))
    full.set(a.id, { url, bytes, mimeType })
  } catch (error) {
    if (mine !== generation) return
    const e = error as Error & { tooLarge?: boolean }
    failures.set(a.id, { message: e.message, tooLarge: e.tooLarge === true })
  } finally {
    if (mine === generation) {
      progress.delete(a.id)
      render()
    }
  }
}

function resetMedia(): void {
  generation++
  for (const url of thumbs.values()) if (url.startsWith('blob:')) URL.revokeObjectURL(url)
  for (const loaded of full.values()) URL.revokeObjectURL(loaded.url)
  thumbs.clear()
  full.clear()
  progress.clear()
  failures.clear()
  unplayable.clear()
  thumbQueue = []
}

function applyState(next: JiraState): void {
  const keyChanged = next.key !== state?.key || next.url !== state?.url
  state = next
  if (keyChanged) {
    resetMedia()
    view = { kind: 'grid' }
  }
  if (view.kind === 'viewer' && !byId(view.id) && next.issue) view = { kind: 'grid' }
  queueThumbnails()
  render()
}

async function refresh(): Promise<void> {
  refreshing = true
  render()
  try {
    resetMedia()
    applyState(await orca.plugin.request('jira.current', { refresh: true }, { timeoutMs: 30_000 }))
  } catch (error) {
    showToast(`Could not refresh: ${(error as Error).message}`)
  } finally {
    refreshing = false
    render()
  }
}

// ---------------------------------------------------------------- actions

function openExternal(url: string): void {
  if (!orca.shell) {
    showToast('Opening links is only available in the desktop app.')
    return
  }
  void orca.shell.openExternal(url).catch((error: Error) => showToast(error.message))
}

function saveAs(a: AttachmentInfo): void {
  const loaded = full.get(a.id)
  if (!loaded || !orca.files) return
  // Called straight from the click: Orca needs the user gesture.
  void orca.files
    .saveAs({ suggestedName: a.filename, mimeType: loaded.mimeType, data: loaded.bytes })
    .catch((error: Error) => showToast(error.message))
}

function openViewer(a: AttachmentInfo): void {
  view = { kind: 'viewer', id: a.id }
  render()
  if (kindOf(a) !== 'file') void loadFull(a)
}

function step(delta: number): void {
  if (view.kind !== 'viewer') return
  const list = attachments()
  const index = list.findIndex((a) => a.id === (view as { id: string }).id)
  if (index < 0 || list.length < 2) return
  openViewer(list[(index + delta + list.length) % list.length])
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
function showToast(message: string): void {
  toast.textContent = message
  toast.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.hidden = true), 5000)
}

// ---------------------------------------------------------------- rendering

const ICONS: Record<string, string> = {
  image: '🖼',
  video: '▶',
  audio: '♪',
  file: '📄'
}

function message(title: string, body?: string, ...extra: Node[]): HTMLElement {
  return el('div', { className: 'message' }, el('div', { className: 'message-title' }, title), body ? el('p', {}, body) : null, ...extra)
}

function button(label: string, onClick: () => void, opts: { title?: string; primary?: boolean; disabled?: boolean } = {}) {
  return el(
    'button',
    {
      type: 'button',
      className: opts.primary ? 'btn primary' : 'btn',
      title: opts.title,
      disabled: opts.disabled,
      onClick
    },
    label
  )
}

function renderTile(a: AttachmentInfo): HTMLElement {
  const thumb = thumbs.get(a.id)
  const kind = kindOf(a)
  const hasImage = Boolean(thumb && thumb !== 'loading' && thumb !== 'error')
  const preview = hasImage
    ? el('img', { src: thumb, alt: '', draggable: 'false' })
    : el('span', { className: `glyph ${thumb === 'loading' ? 'pulse' : ''}` }, ICONS[kind])
  return el(
    'button',
    {
      type: 'button',
      className: 'tile',
      title: `${a.filename}\n${formatSize(a.size)}${a.author ? ` · ${a.author}` : ''}`,
      onClick: () => openViewer(a)
    },
    el('div', { className: `preview ${kind}` }, preview, kind === 'video' && hasImage ? el('span', { className: 'badge' }, '▶') : null),
    el('div', { className: 'name' }, a.filename),
    el('div', { className: 'meta' }, formatSize(a.size))
  )
}

function renderGrid(): HTMLElement[] {
  const s = state!
  const list = attachments()
  const header = el(
    'div',
    { className: 'toolbar' },
    el('div', { className: 'title' }, el('strong', {}, s.key ?? ''), list.length ? ` · ${list.length} attachment${list.length === 1 ? '' : 's'}` : ''),
    el('div', { className: 'spacer' }),
    refreshing ? el('span', { className: 'muted' }, 'Loading…') : null,
    button('↻', () => void refresh(), { title: 'Refresh' })
  )
  if (s.error) return [header, message('Could not load the issue', s.error)]
  if (!s.issue) return [header, message('Loading…')]
  if (!list.length) return [header, message('No attachments', `${s.key} has no attached files.`)]
  return [header, el('div', { className: 'grid' }, ...list.map(renderTile))]
}

function renderViewer(a: AttachmentInfo): HTMLElement[] {
  const kind = kindOf(a)
  const loaded = full.get(a.id)
  const download = progress.get(a.id)
  const failure = failures.get(a.id)
  const count = attachments().length

  const toolbar = el(
    'div',
    { className: 'toolbar' },
    button('←', () => {
      view = { kind: 'grid' }
      render()
    }, { title: 'Back to all attachments (Esc)' }),
    el('div', { className: 'title ellipsis', title: a.filename }, a.filename),
    el('div', { className: 'spacer' }),
    count > 1 ? button('‹', () => step(-1), { title: 'Previous (←)' }) : null,
    count > 1 ? button('›', () => step(1), { title: 'Next (→)' }) : null
  )

  let body: HTMLElement
  if (kind === 'file') {
    body = message('No preview for this file type', `${a.mimeType} · ${formatSize(a.size)}`)
  } else if (failure) {
    body = message(failure.tooLarge ? 'Too large to show here' : 'Could not load the file', failure.message)
  } else if (download) {
    const pct = download.total ? Math.min(100, Math.round((download.received / download.total) * 100)) : 0
    body = el(
      'div',
      { className: 'message' },
      el('div', { className: 'message-title' }, 'Downloading…'),
      el('div', { className: 'bar' }, el('div', { className: 'bar-fill', id: `bar-${a.id}`, style: `width:${pct}%` })),
      el('p', { className: 'muted', id: `bar-text-${a.id}` }, `${formatSize(download.received)} of ${formatSize(download.total)}`)
    )
  } else if (loaded && kind === 'image') {
    const img = el('img', { src: loaded.url, alt: a.filename, className: 'full fit' })
    img.addEventListener('click', () => img.classList.toggle('fit'))
    body = el('div', { className: 'stage' }, img)
  } else if (loaded && (kind === 'video' || kind === 'audio')) {
    if (unplayable.has(a.id)) {
      body = message(
        'This format does not play inside Orca',
        'Save it or open it in the browser to watch it.'
      )
    } else {
      const media = el(kind === 'video' ? 'video' : 'audio', { src: loaded.url, controls: true, className: 'full', preload: 'metadata' })
      media.addEventListener('error', () => {
        unplayable.add(a.id)
        render()
      })
      body = el('div', { className: 'stage' }, media)
    }
  } else {
    body = message('Loading…')
  }

  const actions = el(
    'div',
    { className: 'actions' },
    orca.files ? button('Save…', () => saveAs(a), { disabled: !loaded, title: loaded ? 'Save a copy' : 'Available once downloaded' }) : null,
    button('Open in browser', () => openExternal(a.browserUrl), { primary: !loaded })
  )

  const meta = el(
    'div',
    { className: 'muted small' },
    [a.mimeType, formatSize(a.size), a.author, a.created ? new Date(a.created).toLocaleString(orca.locale) : null]
      .filter(Boolean)
      .join(' · ')
  )
  return [toolbar, body, actions, meta]
}

function updateProgress(id: string): void {
  const p = progress.get(id)
  const bar = document.getElementById(`bar-${id}`)
  const text = document.getElementById(`bar-text-${id}`)
  if (!p || !bar || !text) return
  bar.style.width = `${p.total ? Math.min(100, Math.round((p.received / p.total) * 100)) : 0}%`
  text.textContent = `${formatSize(p.received)} of ${formatSize(p.total)}`
}

function render(): void {
  const s = state
  let content: HTMLElement[]
  if (!s) content = [message('Loading…')]
  else if (s.branch === null) content = [message('No workspace focused')]
  else if (!s.key) content = [message('No Jira key in this branch', `Branch "${s.branch}" has no key like PROJ-123.`)]
  else if (s.needsSite) content = [message(`Found ${s.key}`, 'Set your Jira URL in the Jira Issue panel or in Settings → Plugins → Jira Branch Link.')]
  else if (!s.hasCredentials)
    content = [
      message(
        `${s.key}: sign in to see attachments`,
        'Enter your Atlassian email and API token in the Jira Issue panel. Attachments are downloaded with that login.'
      )
    ]
  else if (view.kind === 'viewer' && byId(view.id)) content = renderViewer(byId(view.id)!)
  else content = renderGrid()
  root.replaceChildren(...content)
}

// ---------------------------------------------------------------- page

const style = document.createElement('style')
style.textContent = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  font: 13px/1.4 var(--orca-font-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif);
  color: var(--orca-foreground, CanvasText);
  background: var(--orca-background, Canvas);
}
#root { display: flex; flex-direction: column; gap: 8px; padding: 8px; min-height: 100%; }
.toolbar { display: flex; align-items: center; gap: 4px; min-height: 28px; }
.title { font-size: 13px; min-width: 0; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.spacer { flex: 1; }
.muted { color: var(--orca-muted-foreground, GrayText); }
.small { font-size: 11px; }
.btn {
  font: inherit; color: inherit; cursor: pointer;
  background: var(--orca-secondary, transparent);
  border: 1px solid var(--orca-border, #8884);
  border-radius: var(--orca-radius, 6px);
  padding: 3px 9px; min-width: 28px; height: 26px;
}
.btn:hover:not(:disabled) { background: var(--orca-accent, #8882); }
.btn:disabled { opacity: .5; cursor: default; }
.btn.primary { background: var(--orca-primary, #3b82f6); color: var(--orca-primary-foreground, white); border-color: transparent; }
.btn:focus-visible, .tile:focus-visible { outline: 2px solid var(--orca-ring, #3b82f6); outline-offset: 1px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 8px; }
.tile {
  font: inherit; color: inherit; text-align: left; cursor: pointer; padding: 0;
  background: var(--orca-card, transparent);
  border: 1px solid var(--orca-border, #8884);
  border-radius: var(--orca-radius, 6px);
  overflow: hidden; display: flex; flex-direction: column;
}
.tile:hover { border-color: var(--orca-ring, #3b82f6); }
.preview {
  position: relative; aspect-ratio: 4 / 3; display: grid; place-items: center;
  background: var(--orca-muted, #8881); overflow: hidden;
}
.preview img { width: 100%; height: 100%; object-fit: cover; }
.glyph { font-size: 26px; opacity: .7; }
.pulse { animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .25; } }
.badge {
  position: absolute; right: 6px; bottom: 6px; font-size: 10px; padding: 2px 6px;
  border-radius: 999px; background: #000a; color: #fff;
}
.name { padding: 5px 7px 0; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { padding: 0 7px 6px; font-size: 11px; color: var(--orca-muted-foreground, GrayText); }
.stage {
  display: grid; place-items: center; overflow: auto; max-height: calc(100vh - 140px);
  background: var(--orca-muted, #8881); border-radius: var(--orca-radius, 6px);
}
.full { display: block; }
img.full { cursor: zoom-out; }
img.full.fit { max-width: 100%; max-height: calc(100vh - 140px); cursor: zoom-in; }
video.full { width: 100%; max-height: calc(100vh - 140px); background: #000; }
audio.full { width: 100%; margin: 24px 8px; }
.actions { display: flex; gap: 6px; flex-wrap: wrap; }
.message { padding: 24px 8px; text-align: center; }
.message-title { font-weight: 600; margin-bottom: 4px; }
.message p { margin: 4px 0 0; color: var(--orca-muted-foreground, GrayText); overflow-wrap: anywhere; }
.bar { height: 4px; margin: 12px auto 0; max-width: 240px; border-radius: 2px; background: var(--orca-muted, #8883); overflow: hidden; }
.bar-fill { height: 100%; background: var(--orca-primary, #3b82f6); transition: width .2s; }
.toast {
  position: fixed; left: 8px; right: 8px; bottom: 8px; padding: 8px 10px; font-size: 12px;
  border-radius: var(--orca-radius, 6px);
  background: var(--orca-destructive, #dc2626); color: var(--orca-destructive-foreground, white);
}
`
document.head.append(style)
const root = el('div', { id: 'root' })
const toast = el('div', { className: 'toast', role: 'status' })
toast.hidden = true
document.body.append(root, toast)

document.addEventListener('keydown', (event) => {
  if (view.kind !== 'viewer' || (event.target as HTMLElement).tagName === 'VIDEO') return
  if (event.key === 'Escape') {
    view = { kind: 'grid' }
    render()
  } else if (event.key === 'ArrowLeft') step(-1)
  else if (event.key === 'ArrowRight') step(1)
})

orca.plugin.on('jira.changed', (next) => applyState(next))
render()
orca.plugin
  .request('jira.current', {}, { timeoutMs: 30_000 })
  .then(applyState)
  .catch((error: Error) => {
    root.replaceChildren(message('Could not reach the plugin worker', error.message))
  })
