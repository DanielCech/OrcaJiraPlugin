// Panel <-> worker contract, shared by src/panel.tsx and worker/main.mjs.
export {}

export type IssueDetails = {
  key: string
  summary: string
  status: string | null
  statusCategory: 'new' | 'indeterminate' | 'done' | null
  type: string | null
  priority: string | null
  assignee: string | null
  reporter: string | null
  updated: number | null
  description: string
  /** newest first */
  attachments: AttachmentInfo[]
}

export type AttachmentInfo = {
  id: string
  filename: string
  mimeType: string
  /** bytes, as Jira reports them */
  size: number
  created: number | null
  author: string | null
  /** Jira can render a thumbnail (images, some documents) */
  hasThumbnail: boolean
  /** opens in the browser with its own Jira login */
  browserUrl: string
}

export type AttachmentRequest = { id: string; kind: 'thumbnail' | 'content'; offset: number }

export type AttachmentChunk =
  | {
      ok: true
      mimeType: string
      /** total size of the file */
      size: number
      offset: number
      /** base64 of bytes [offset, offset + chunk) */
      data: string
      done: boolean
    }
  | { ok: false; error: string; tooLarge?: boolean }

export type JiraState = {
  /** null when no workspace is focused */
  branch: string | null
  key: string | null
  url: string | null
  /** true when the branch has a key but no Jira URL is configured yet */
  needsSite: boolean
  /** true when an email and API token are set, so details can be fetched */
  hasCredentials: boolean
  /** the Atlassian email from Settings ('' when not set) */
  email: string
  /** true when an API token is stored in the plugin's secrets */
  hasToken: boolean
  /** attachments larger than this are not downloaded into Orca (Settings → Max attachment size) */
  maxMediaBytes: number
  issue: IssueDetails | null
  error: string | null
}

declare module 'orca' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
  interface PluginRequests {
    'jira.current': { input: { refresh?: boolean }; output: JiraState }
    'jira.attachment': { input: AttachmentRequest; output: AttachmentChunk }
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
  interface PluginPanelEvents {
    'jira.changed': JiraState
  }
}
