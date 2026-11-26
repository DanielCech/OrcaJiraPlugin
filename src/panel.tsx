// Jira Issue panel: shows the issue whose key is in the focused workspace's branch name.
// No build step: Orca strips the types and compiles the JSX when it loads.
import {
  atom,
  Badge,
  Button,
  Callout,
  EmptyState,
  Heading,
  IconButton,
  Input,
  KeyValue,
  Markdown,
  plugin,
  read,
  RelativeTime,
  Row,
  secrets,
  set,
  settings,
  shell,
  Spinner,
  Stack,
  Text,
  type PanelContext
} from 'orca'
import type { JiraState } from './protocol'

const state = atom<JiraState | null>(null)
const loading = atom(false)
const tokenDraft = atom('')
const emailDraft = atom<string | null>(null)
const saving = atom(false)
const notice = atom<string | null>(null)
const siteDraft = atom('')

async function saveSite(): Promise<void> {
  const site = read(siteDraft).trim()
  if (!site) {
    set(notice, 'Enter your Jira URL or Atlassian site name.')
    return
  }
  set(saving, true)
  set(notice, null)
  try {
    await settings.set('baseUrl', site)
    set(siteDraft, '')
    await load(true)
  } catch (error) {
    const e = error as Error & { code?: string }
    set(notice, `Could not save: ${e.code ? `${e.code}: ` : ''}${e.message}`)
  } finally {
    set(saving, false)
  }
}

async function load(refresh = false): Promise<void> {
  set(loading, true)
  try {
    set(state, await plugin.request('jira.current', { refresh }, { timeoutMs: 30_000 }))
  } catch (error) {
    set(notice, `Could not reach the plugin worker: ${(error as Error).message}`)
  } finally {
    set(loading, false)
  }
}

async function saveCredentials(): Promise<void> {
  const current = read(state)
  const email = (read(emailDraft) ?? current?.email ?? '').trim()
  const token = read(tokenDraft).trim()
  if (!email) {
    set(notice, 'Enter the email of the Atlassian account that created the token.')
    return
  }
  if (!token && !current?.hasToken) {
    set(notice, 'Paste the API token.')
    return
  }
  set(saving, true)
  set(notice, null)
  try {
    if (email !== current?.email) await settings.set('email', email)
    if (token) await secrets.set('apiToken', token)
    set(tokenDraft, '')
    set(emailDraft, null)
    await load(true)
    const after = read(state)
    if (after && !after.hasCredentials) {
      set(notice, `Saved, but the plugin still sees ${!after.email ? 'no email' : 'no token'}. Try Refresh.`)
    }
  } catch (error) {
    const e = error as Error & { code?: string }
    set(notice, `Could not save: ${e.code ? `${e.code}: ` : ''}${e.message}`)
  } finally {
    set(saving, false)
  }
}

async function forgetToken(): Promise<void> {
  await secrets.delete('apiToken').catch(() => undefined)
  await load(true)
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('jira.changed', (next) => set(state, next)))
  void load()
}

function toneFor(category: string | null): 'neutral' | 'accent' | 'success' {
  return category === 'done' ? 'success' : category === 'indeterminate' ? 'accent' : 'neutral'
}

function CredentialsForm({ email, hasToken }: { email: string; hasToken: boolean }) {
  const emailValue = read(emailDraft) ?? email
  const busy = read(saving)
  return (
    <Callout tone="neutral" icon="info" title="Show issue details here">
      <Stack gap="sm">
        <Text size="sm">
          Use the email of your Atlassian account and an API token from id.atlassian.com → Security →
          API tokens. The token is stored in the plugin's encrypted secrets.
        </Text>
        <Input
          label="Atlassian email"
          placeholder="you@company.com"
          value={emailValue}
          onChange={(value) => set(emailDraft, value)}
        />
        <Input
          label="API token"
          type="password"
          placeholder={hasToken ? 'Token saved – paste a new one to replace it' : 'Jira API token'}
          value={read(tokenDraft)}
          onChange={(value) => set(tokenDraft, value)}
          onSubmit={() => void saveCredentials()}
        />
        <Row gap="xs" align="center">
          <Button onPress={() => void saveCredentials()} disabled={busy}>
            Save
          </Button>
          {busy ? <Spinner label="Saving" labelHidden /> : null}
          <Text muted size="xs">
            {email ? 'Email ✓' : 'Email missing'} · {hasToken ? 'Token ✓' : 'Token missing'}
          </Text>
        </Row>
      </Stack>
    </Callout>
  )
}

function SiteForm({ issueKey }: { issueKey: string }) {
  const busy = read(saving)
  return (
    <Callout tone="neutral" icon="info" title="Which Jira should this open?">
      <Stack gap="sm">
        <Text size="sm">
          Found {issueKey} in the branch name. Enter your Jira site once: a full URL such as
          https://your-company.atlassian.net, or just the site name your-company.
        </Text>
        <Input
          label="Jira URL"
          placeholder="your-company or https://your-company.atlassian.net"
          value={read(siteDraft)}
          onChange={(value) => set(siteDraft, value)}
          onSubmit={() => void saveSite()}
        />
        <Row gap="xs" align="center">
          <Button onPress={() => void saveSite()} disabled={busy}>
            Save
          </Button>
          {busy ? <Spinner label="Saving" labelHidden /> : null}
        </Row>
      </Stack>
    </Callout>
  )
}

export default function Panel() {
  const s = read(state)
  const message = read(notice)

  if (!s) {
    return <Spinner label="Loading" />
  }
  if (s.branch === null) {
    return <EmptyState icon="branch" title="No workspace focused" />
  }
  if (!s.key) {
    return (
      <EmptyState
        icon="link"
        title="No Jira key in this branch"
        description={`Branch "${s.branch}" has no key like PROJ-123.`}
      />
    )
  }
  if (!s.url) {
    return (
      <Stack gap="md">
        <Heading level={2}>{s.key}</Heading>
        {message ? <Callout tone="danger">{message}</Callout> : null}
        <SiteForm issueKey={s.key} />
        <Text muted size="xs">
          Branch: {s.branch}
        </Text>
      </Stack>
    )
  }

  const issue = s.issue
  const url = s.url
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Row gap="xs" align="center">
          <Heading level={2}>{s.key}</Heading>
          {issue?.status ? <Badge tone={toneFor(issue.statusCategory)}>{issue.status}</Badge> : null}
        </Row>
        <Row gap="xs">
          {read(loading) ? <Spinner label="Loading" labelHidden /> : null}
          <IconButton icon="refresh" label="Refresh" onPress={() => void load(true)} />
        </Row>
      </Row>

      {issue ? <Text weight="semibold">{issue.summary}</Text> : null}

      <Button icon="open-external" variant="solid" onPress={() => void shell.openExternal(url)}>
        Open in Jira
      </Button>

      {message ? <Callout tone="danger">{message}</Callout> : null}
      {s.error ? <Callout tone="warning" icon="warning">{s.error}</Callout> : null}

      {issue ? (
        <Stack gap="md">
          <KeyValue
            items={[
              { label: 'Type', value: issue.type ?? '—' },
              { label: 'Priority', value: issue.priority ?? '—' },
              { label: 'Assignee', value: issue.assignee ?? 'Unassigned' },
              { label: 'Reporter', value: issue.reporter ?? '—' }
            ]}
          />
          {issue.updated ? (
            <Text muted size="xs">
              Updated <RelativeTime at={issue.updated} />
            </Text>
          ) : null}
          {issue.attachments?.length ? (
            <Text muted size="sm">
              📎 {issue.attachments.length} attachment{issue.attachments.length === 1 ? '' : 's'}: open the
              Jira Attachments panel to view images and videos.
            </Text>
          ) : null}
          {issue.description ? (
            <Markdown content={issue.description} />
          ) : (
            <Text muted>No description.</Text>
          )}
        </Stack>
      ) : null}

      {!s.hasCredentials || s.error?.startsWith('Jira refused') ? (
        <CredentialsForm email={s.email} hasToken={s.hasToken} />
      ) : null}

      <Text muted size="xs">
        Branch: {s.branch}
      </Text>
      {s.hasToken ? (
        <Button variant="ghost" size="xs" onPress={() => void forgetToken()}>
          Forget API token
        </Button>
      ) : null}
    </Stack>
  )
}
