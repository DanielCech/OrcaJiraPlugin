// Worker for Jira Branch Link. It follows the focused workspace, pulls the Jira key out of its
// branch name, keeps the status bar item current, opens the issue in the browser and (with an
// email and API token) fetches the issue for the panel.
import { execFile } from 'node:child_process'

/** A Jira key such as PROJ-123: uppercase project key (letters, then letters/digits), dash, number. */
const KEY_RE = /(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]{1,9}-\d+)(?!\d)/
/** The same, any case (opt-in: also hits names like fix-2-buttons). */
const KEY_RE_ANY_CASE = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9}-\d+)(?!\d)/
const CACHE_MS = 60_000
const TOKEN_SECRET = 'apiToken'

/** @param {string | null | undefined} branch @param {{ lowercase?: boolean }} [options] */
export function extractKey(branch, { lowercase = false } = {}) {
  if (!branch) return null
  const match = KEY_RE.exec(branch) ?? (lowercase ? KEY_RE_ANY_CASE.exec(branch) : null)
  return match ? match[1].toUpperCase() : null
}

/** @param {string} text "ABC=https://x.atlassian.net" lines */
export function parseOverrides(text) {
  /** @type {Record<string, string>} */
  const map = {}
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    map[line.slice(0, eq).trim().toUpperCase()] = normalizeBase(line.slice(eq + 1))
  }
  return map
}

/**
 * Accepts a full URL (https://jira.example.com), a host (jira.example.com) or just an Atlassian
 * Cloud site name (your-company -> https://your-company.atlassian.net). '' when empty.
 * @param {unknown} url
 */
export function normalizeBase(url) {
  let value = String(url ?? '').trim().replace(/\/+$/, '')
  if (!value) return ''
  if (!/^https?:\/\//i.test(value)) {
    value = value.includes('.') ? `https://${value}` : `https://${value}.atlassian.net`
  }
  return value
}

/** @param {string} key @param {string} baseUrl @param {Record<string, string>} overrides */
export function siteFor(key, baseUrl, overrides) {
  const project = key.split('-')[0]
  return overrides[project] || normalizeBase(baseUrl)
}

// ---------- Atlassian Document Format -> Markdown (enough for issue descriptions) ----------

/** @param {any} node */
function inline(node) {
  if (!node) return ''
  switch (node.type) {
    case 'text': {
      let t = node.text ?? ''
      for (const mark of node.marks ?? []) {
        if (mark.type === 'code') t = '`' + t + '`'
        else if (mark.type === 'strong') t = `**${t}**`
        else if (mark.type === 'em') t = `_${t}_`
        else if (mark.type === 'strike') t = `~~${t}~~`
        else if (mark.type === 'link' && mark.attrs?.href) t = `[${t}](${mark.attrs.href})`
      }
      return t
    }
    case 'hardBreak':
      return '  \n'
    case 'mention':
      return node.attrs?.text ?? '@someone'
    case 'emoji':
      return node.attrs?.text ?? node.attrs?.shortName ?? ''
    case 'inlineCard':
    case 'blockCard':
      return node.attrs?.url ? `<${node.attrs.url}>` : ''
    case 'status':
      return node.attrs?.text ? `**[${node.attrs.text}]**` : ''
    case 'date':
      return node.attrs?.timestamp ? new Date(Number(node.attrs.timestamp)).toISOString().slice(0, 10) : ''
    default:
      return (node.content ?? []).map(inline).join('')
  }
}

/** @param {any} node @param {string} indent */
function block(node, indent = '') {
  if (!node) return ''
  const children = node.content ?? []
  switch (node.type) {
    case 'doc':
      return children.map((c) => block(c)).filter(Boolean).join('\n\n')
    case 'paragraph':
      return indent + children.map(inline).join('')
    case 'heading':
      return '#'.repeat(Math.min(6, node.attrs?.level ?? 3)) + ' ' + children.map(inline).join('')
    case 'bulletList':
    case 'orderedList':
      return children
        .map((item, i) => {
          const marker = node.type === 'orderedList' ? `${i + 1}. ` : '- '
          const parts = (item.content ?? []).map((c) => block(c, indent + '   '))
          const first = (parts.shift() ?? '').trimStart()
          return [indent + marker + first, ...parts].join('\n')
        })
        .join('\n')
    case 'taskList':
      return children
        .map((item) => `${indent}- [${item.attrs?.state === 'DONE' ? 'x' : ' '}] ${inline(item)}`)
        .join('\n')
    case 'codeBlock':
      return '```' + (node.attrs?.language ?? '') + '\n' + children.map(inline).join('') + '\n```'
    case 'blockquote':
      return children.map((c) => block(c)).join('\n\n').split('\n').map((l) => '> ' + l).join('\n')
    case 'panel':
      return children.map((c) => block(c)).join('\n\n').split('\n').map((l) => '> ' + l).join('\n')
    case 'rule':
      return '---'
    case 'table':
      return children
        .map((row, r) => {
          const cells = (row.content ?? []).map((cell) =>
            (cell.content ?? []).map((c) => block(c)).join(' ').replace(/\|/g, '\\|').replace(/\n/g, ' ')
          )
          const line = '| ' + cells.join(' | ') + ' |'
          return r === 0 ? line + '\n|' + cells.map(() => ' --- |').join('') : line
        })
        .join('\n')
    case 'mediaSingle':
    case 'mediaGroup':
      return '_(attachment – open the issue in Jira to see it)_'
    default:
      return children.length ? children.map((c) => block(c, indent)).join('\n') : inline(node)
  }
}

/** @param {any} adf */
export function adfToMarkdown(adf) {
  if (!adf) return ''
  if (typeof adf === 'string') return adf
  return block(adf).trim()
}

// ---------- Worker ----------

/** @param {string} url */
function openInBrowser(url) {
  return new Promise((resolve, reject) => {
    if (!/^https?:\/\//.test(url)) return reject(new Error('Not an http(s) URL'))
    const [cmd, args] =
      process.platform === 'darwin'
        ? ['open', [url]]
        : process.platform === 'win32'
          ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
          : ['xdg-open', [url]]
    execFile(cmd, args, (error) => (error ? reject(error) : resolve(undefined)))
  })
}

/** @param {string} text @param {number} max */
function truncate(text, max) {
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text
}

/** @type {import('orca/worker').Activate} */
export default async function activate(orca) {
  /** @type {{ branch: string | null; key: string | null; url: string | null; site: string | null }} */
  let current = { branch: null, key: null, url: null, site: null }
  /** @type {Map<string, { at: number; issue?: any; error?: string }>} */
  const cache = new Map()
  let lastIssue = null
  let lastError = null

  const setting = async (key) => orca.settings.get(key)

  async function credentialParts() {
    const email = String((await setting('email')) ?? '').trim()
    let token = null
    try {
      token = (await orca.secrets.get(TOKEN_SECRET))?.trim() || null
    } catch (error) {
      orca.log(`secrets.get failed: ${error?.message ?? error}`)
      token = null
    }
    return { email, token }
  }

  async function credentials() {
    const { email, token } = await credentialParts()
    return email && token ? { email, token } : null
  }

  /** @type {Map<string, string | null>} site -> Atlassian cloud id (for scoped tokens) */
  const cloudIds = new Map()
  /** @param {string} site */
  async function cloudIdFor(site) {
    if (cloudIds.has(site)) return cloudIds.get(site) ?? null
    let id = null
    try {
      const res = await fetch(`${site}/_edge/tenant_info`, { signal: AbortSignal.timeout(10_000) })
      if (res.ok) id = (await res.json())?.cloudId ?? null
    } catch (error) {
      orca.log(`tenant_info for ${site} failed: ${error?.message ?? error}`)
    }
    cloudIds.set(site, id)
    return id
  }

  async function resolve(branch) {
    const key = extractKey(branch, { lowercase: (await setting('lowercaseKeys')) === true })
    if (!key) return { branch, key: null, url: null, site: null }
    const site = siteFor(key, String((await setting('baseUrl')) ?? ''), parseOverrides(String((await setting('siteOverrides')) ?? '')))
    return { branch, key, site, url: site ? `${site}/browse/${key}` : null }
  }

  async function fetchIssue(force = false) {
    lastIssue = null
    lastError = null
    const { key, site } = current
    if (!key || !site) return
    const creds = await credentials()
    if (!creds) return
    const cacheKey = `${site}|${key}`
    const hit = cache.get(cacheKey)
    if (!force && hit && Date.now() - hit.at < CACHE_MS) {
      lastIssue = hit.issue ?? null
      lastError = hit.error ?? null
      return
    }
    try {
      const fields = 'summary,status,issuetype,priority,assignee,reporter,updated,description'
      const path = `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`
      const get = (base) =>
        fetch(base + path, {
          headers: {
            Accept: 'application/json',
            Authorization: 'Basic ' + Buffer.from(`${creds.email}:${creds.token}`).toString('base64')
          },
          signal: AbortSignal.timeout(15_000)
        })
      let res = await get(site)
      // API tokens "with scopes" only work through the Atlassian API gateway, not the site URL.
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        const cloudId = await cloudIdFor(site)
        if (cloudId) {
          const viaGateway = await get(`https://api.atlassian.com/ex/jira/${cloudId}`)
          if (viaGateway.ok || res.status !== 404) res = viaGateway
        }
      }
      if (!res.ok) {
        orca.log(`GET ${key} on ${site}: ${res.status} ${res.statusText}`)
        lastError =
          res.status === 401 || res.status === 403
            ? `Jira refused the login (${res.status}). Check that the email matches the Atlassian account that created the token, and that a scoped token has read:jira-work.`
            : res.status === 404
              ? `${key} was not found on ${site}, or your account cannot see it.`
              : `Jira answered ${res.status} ${res.statusText}.`
      } else {
        const data = await res.json()
        const f = data.fields ?? {}
        lastIssue = {
          key: data.key ?? key,
          summary: f.summary ?? '',
          status: f.status?.name ?? null,
          statusCategory: f.status?.statusCategory?.key ?? null,
          type: f.issuetype?.name ?? null,
          priority: f.priority?.name ?? null,
          assignee: f.assignee?.displayName ?? null,
          reporter: f.reporter?.displayName ?? null,
          updated: f.updated ? Date.parse(f.updated) : null,
          description: truncate(adfToMarkdown(f.description), 12_000)
        }
      }
    } catch (error) {
      orca.log(`GET ${key} on ${site} threw: ${error?.message ?? error}`)
      lastError = `Could not reach Jira: ${error?.message ?? error}`
    }
    cache.set(cacheKey, { at: Date.now(), issue: lastIssue ?? undefined, error: lastError ?? undefined })
  }

  async function state() {
    const { email, token } = await credentialParts()
    return {
      branch: current.branch,
      key: current.key,
      url: current.url,
      needsSite: Boolean(current.key && !current.site),
      hasCredentials: Boolean(email && token),
      email,
      hasToken: Boolean(token),
      issue: lastIssue && lastIssue.key === current.key ? lastIssue : null,
      error: lastError
    }
  }

  async function updateStatusBar() {
    if (!current.key) {
      await orca.host.call('statusBar.update', { id: 'issue', visible: false }).catch(() => undefined)
      return
    }
    const issue = lastIssue && lastIssue.key === current.key ? lastIssue : null
    const showSummary = (await setting('statusBarSummary')) !== false
    const text = issue && showSummary && issue.summary ? `${current.key} · ${truncate(issue.summary, 40)}` : current.key
    const tone =
      issue?.statusCategory === 'done' ? 'success' : issue?.statusCategory === 'indeterminate' ? 'accent' : 'neutral'
    const tooltip = !current.url
      ? `${current.key}: set your Jira URL in Settings → Plugins → Jira Branch Link (or in the Jira Issue panel)`
      : issue
        ? `${current.key}: ${issue.summary}${issue.status ? ` (${issue.status})` : ''} — click to open in Jira`
        : `Open ${current.key} in Jira`
    await orca.host
      .call('statusBar.update', { id: 'issue', text, tone, tooltip, visible: true })
      .catch((e) => orca.log(`statusBar.update failed: ${e?.message ?? e}`))
  }

  let generation = 0
  async function refresh(branch, { force = false } = {}) {
    const mine = ++generation
    current = await resolve(branch)
    lastIssue = null
    lastError = null
    await updateStatusBar()
    orca.panels.post('jira.changed', await state())
    await fetchIssue(force)
    if (mine !== generation) return // the focus moved while we were fetching
    await updateStatusBar()
    orca.panels.post('jira.changed', await state())
  }

  orca.events.on('workspace.changed', ({ context }) => {
    const branch = context ? context.branch : null
    if (branch === current.branch) return // terminals opened/closed/renamed, the branch is the same
    void refresh(branch)
  })

  orca.settings.onDidChange(() => {
    cache.clear()
    void refresh(current.branch, { force: true })
  })

  orca.commands.register('jira.openCurrent', async () => {
    if (!current.key) {
      return current.branch
        ? `No Jira key in branch "${current.branch}".`
        : 'No workspace is focused.'
    }
    if (!current.url) {
      return `Found ${current.key}, but no Jira URL is set. Add it in Settings → Plugins → Jira Branch Link or in the Jira Issue panel.`
    }
    try {
      await openInBrowser(current.url)
      return `Opened ${current.key}`
    } catch (error) {
      return `Could not open ${current.url}: ${error?.message ?? error}`
    }
  })

  orca.commands.register('jira.refresh', async () => {
    cache.clear()
    await refresh(current.branch, { force: true })
    return lastError ?? (current.key ? `Refreshed ${current.key}` : 'No Jira key in this branch.')
  })

  orca.panels.handle('jira.current', async (input) => {
    if (/** @type {{ refresh?: boolean } | null} */ (input)?.refresh) {
      cache.clear()
      await refresh(current.branch, { force: true })
    }
    return state()
  })

  // First state, before any event arrives.
  try {
    const context = await orca.host.call('workspace.readContext', {})
    await refresh(context ? context.branch : null)
  } catch (error) {
    orca.log(`workspace.readContext failed: ${error?.message ?? error}`)
    await updateStatusBar()
  }
}
