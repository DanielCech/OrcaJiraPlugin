import assert from 'node:assert/strict'
// Run: node tests/worker.test.mjs  (no dependencies; fetch and the Orca host are mocked)
const P = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const { default: activate, CHUNK_BYTES } = await import(P + '/worker/main.mjs')

const big = Buffer.alloc(2_000_000, 7); big[1_999_999] = 42
const thumb = Buffer.from('PNGTHUMB')
let fetches = []
globalThis.fetch = async (url, init) => {
  fetches.push(url)
  const ok = (body, type) => new Response(body, { status: 200, headers: { 'content-type': type } })
  if (url.includes('/rest/api/3/issue/PROJ-1')) {
    assert.match(init.headers.Authorization, /^Basic /)
    return ok(JSON.stringify({ key: 'PROJ-1', fields: { summary: 'S', attachment: [
      { id: 10, filename: 'shot.png', mimeType: 'image/png', size: 8, created: '2026-01-01T00:00:00Z', thumbnail: 'x' },
      { id: 11, filename: 'clip.mov', mimeType: 'video/quicktime', size: big.length, created: '2026-02-01T00:00:00Z' },
      { id: 12, filename: 'huge.mp4', mimeType: 'video/mp4', size: 900e6, created: '2025-01-01T00:00:00Z' } ] } }), 'application/json')
  }
  if (url.endsWith('/attachment/thumbnail/10?fallbackToDefault=false')) return ok(thumb, 'image/png')
  if (url.endsWith('/attachment/content/11')) return ok(big, 'application/octet-stream')
  return new Response('nope', { status: 404 })
}
const handlers = {}, posts = []
const settings = { baseUrl: 'acme', siteOverrides: '', email: 'a@b.c', statusBarSummary: true, lowercaseKeys: false, maxMediaMB: 50 }
const orca = {
  log: () => {}, settings: { get: async (k) => settings[k], onDidChange: () => {} },
  secrets: { get: async () => 'tok' },
  host: { call: async (m) => (m === 'workspace.readContext' ? { branch: 'feature/PROJ-1-x' } : {}) },
  panels: { post: (e, p) => posts.push(p), handle: (n, f) => (handlers[n] = f) },
  events: { on: () => {} }, commands: { register: () => {} }
}
await activate(orca)
const st = await handlers['jira.current']({})
assert.equal(st.url, 'https://acme.atlassian.net/browse/PROJ-1')
assert.equal(st.maxMediaBytes, 50 * 1048576)
assert.deepEqual(st.issue.attachments.map((a) => a.id), ['11', '10', '12'], 'newest first')
assert.equal(st.issue.attachments[1].browserUrl, 'https://acme.atlassian.net/secure/attachment/10/shot.png')
assert.equal(st.issue.attachments[0].hasThumbnail, false)

const t = await handlers['jira.attachment']({ id: '10', kind: 'thumbnail', offset: 0 })
assert.equal(t.ok, true); assert.equal(Buffer.from(t.data, 'base64').toString(), 'PNGTHUMB'); assert.equal(t.done, true)

let offset = 0, parts = [], n = 0
for (;;) {
  const c = await handlers['jira.attachment']({ id: '11', kind: 'content', offset })
  assert.equal(c.ok, true, c.error); assert.equal(c.mimeType, 'video/quicktime')
  assert.ok(JSON.stringify(c).length < 1024 * 1024, 'chunk under 1 MiB')
  const b = Buffer.from(c.data, 'base64'); parts.push(b); offset += b.length; n++
  if (c.done) break
}
assert.equal(n, Math.ceil(big.length / CHUNK_BYTES)); assert.ok(Buffer.concat(parts).equals(big))
assert.equal(fetches.filter((u) => u.endsWith('/content/11')).length, 1, 'downloaded once, then cached')

const huge = await handlers['jira.attachment']({ id: '12', kind: 'content', offset: 0 })
assert.equal(huge.ok, false); assert.equal(huge.tooLarge, true)
const foreign = await handlers['jira.attachment']({ id: '999', kind: 'content', offset: 0 })
assert.equal(foreign.ok, false)
const missing = await handlers['jira.attachment']({ id: '10', kind: 'content', offset: 0 })
assert.equal(missing.ok, false); assert.match(missing.error, /404/)
console.log(`worker OK — ${n} chunks for 2 MB, size cap, unknown id, 404 all handled`)
