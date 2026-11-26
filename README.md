# Orca Jira Plugin (Jira Branch Link)

An [Orca](https://github.com/stablyai/orca) plugin that connects the workspace you are working in to its Jira issue.

## Why

In Orca every task usually gets its own worktree and branch, and the branch name already carries the Jira key: `feature/PROJ-123-login`, `bugfix/ABC-42_crash`, `dc/feat/XY-7-onboarding`. This plugin reads that key from the focused workspace's branch, so you never have to copy a key, search Jira or keep a browser tab per task. The issue sits right next to the code and the agents working on it.

## Features

- **Status bar item**: shows the key of the focused workspace's issue (with your token, also its summary, colored by status category). Click it to open the issue in your browser.
- **Command** `Jira: Open Issue for Current Branch` (`Cmd+Alt+J` / `Ctrl+Alt+J`), and `Jira: Refresh Issue`.
- **Jira Issue panel** in the right sidebar: key, status, summary, type, priority, assignee, reporter, last update and the description rendered as Markdown.
- **Jira Attachments panel** in the right sidebar: a thumbnail grid of the issue's attachments, an image viewer (click to zoom), a video and audio player, **Save…** and **Open in browser**. Use `←` / `→` to step through and `Esc` to go back.
- **Works with any Jira**: Atlassian Cloud or self-hosted, and several sites at once (per project key).
- **Follows focus**: switching workspaces updates the status bar and the panel right away. Issues are cached for 60 seconds.

### How the key is found

The first match of `[A-Z][A-Z0-9]{1,9}-<number>` anywhere in the branch name, so any project key works:

| Branch | Key |
| --- | --- |
| `PROJ-123` | `PROJ-123` |
| `feature/ABC-12-login` | `ABC-12` |
| `bugfix/XY2-7_fix` | `XY2-7` |
| `feature/abc-12-login` | none (`ABC-12` with *Also match lowercase keys* on) |
| `fix-2-buttons`, `release/1.2.3`, `main` | none |

Only uppercase keys match by default, so names like `fix-2-buttons` are not taken for issues. Teams that use lowercase branch names can turn on **Also match lowercase keys**.

## Requirements

- Orca **1.4.248** or newer (`orca --version`)
- macOS, Linux or Windows desktop app
- For issue details in Orca (optional): an Atlassian account and an [API token](https://id.atlassian.com/manage-profile/security/api-tokens)

## Installation

### From GitHub (recommended)

Run this in a terminal (Orca's built-in terminal works):

```bash
orca plugin install DanielCech/OrcaJiraPlugin
```

The plugin runs code, so Orca first answers `approval_required`. It lists what the plugin will be allowed to do (see [Permissions](#permissions)) and gives you the exact command to re-run with `--approve <fingerprint>`. Review it, then run that command.

You can also pin a version with `orca plugin install DanielCech/OrcaJiraPlugin@v1.1.0`, or install from **Settings → Plugins** in Orca.

To update later:

```bash
orca plugin update <plugin-key>   # or just `orca plugin update` for all plugins
```

`orca plugin list` shows the plugin key on your machine (it depends on where you installed from).

### From a local clone (for development)

```bash
git clone https://github.com/DanielCech/OrcaJiraPlugin.git
orca plugin dev load ./OrcaJiraPlugin --json
```

Approve it the same way. The folder then shows up under **Settings → Plugins → Development folders**, and `orca plugin dev reload` picks up your edits.

## Setup

### 1. Tell the plugin which Jira to use

The plugin has no default Jira site. Set it in one of two places:

- **Settings → Plugins → Jira Branch Link → Jira URL**, or
- the **Jira Issue** panel: when the branch has a key but no site is set, the panel asks for it.

Any of these forms works:

| You type | Used as |
| --- | --- |
| `your-company` | `https://your-company.atlassian.net` |
| `jira.example.com` | `https://jira.example.com` |
| `https://your-company.atlassian.net` | as is |

Issues open at `<Jira URL>/browse/<KEY>`.

### 2. (Optional) Show issue details inside Orca

Opening issues in the browser needs no login. To see the details and attachments in Orca and the summary in the status bar:

1. Create an API token at **id.atlassian.com → Security → API tokens**. A classic token works. With a scoped token, grant `read:jira-work`.
2. Open the **Jira Issue** panel (right sidebar), enter the **email of the Atlassian account** that created the token, paste the token and press **Save**.

The token goes into the plugin's encrypted secrets (OS keychain), never into settings or files. **Forget API token** at the bottom of the panel removes it.

Scoped tokens only work through the Atlassian API gateway. The plugin handles that itself: when the site URL refuses the token, it looks up your site's cloud id and retries through `api.atlassian.com`.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Jira URL | empty | Your Jira site: full URL, host, or Atlassian Cloud site name |
| Other Jira sites by project key | empty | One per line, `PROJECT=site`, for projects that live on another Jira, e.g. `ABC=client-company` or `ABC=https://jira.client.com` |
| Atlassian account email | empty | Needed only for issue details (together with the API token) |
| Also match lowercase keys | off | Also finds `feature/proj-123-login` |
| Max attachment size to show in Orca (MB) | 50 | Larger files are not downloaded into the Attachments panel; open them in the browser instead |
| Show issue summary in the status bar | on | `PROJ-123 · Login screen` instead of only `PROJ-123` |

## Permissions

| Capability | Why |
| --- | --- |
| `workspace:read` | Read the branch of the focused workspace |
| `settings:own` | Read and write the plugin's own settings |
| `secrets:own` | Store the API token encrypted |

The worker talks only to your configured Jira site(s): `GET /rest/api/3/issue/<KEY>`, `/rest/api/3/attachment/thumbnail|content/<id>` (Jira redirects these to its media service), `/_edge/tenant_info` (to find the cloud id), and `api.atlassian.com` for scoped tokens. It opens links with the system browser.

## How the Attachments panel works

Orca's component panels can only show images bundled with the plugin, so the Attachments panel is an HTML panel. HTML panels may show `blob:` images and video, but they have no network access. So the worker downloads each file with your Jira login and passes it to the panel in base64 chunks of about 700 KB, because Orca caps each answer at 1 MiB. The panel joins the chunks into a `Blob`.

- Thumbnails load as soon as the panel opens. Full files download only when you open them, with a progress bar.
- Downloads are cached in the worker (up to 200 MB, oldest dropped first), so switching between workspaces does not download them again.
- Orca allows a panel 120 requests per 10 seconds, which works out to about 8 MB per 10 seconds. That is why there is a size limit setting; larger files open in the browser.
- Files with no preview (zip, pdf, …) are not downloaded. You get **Open in browser** instead.
- `.mov` screen recordings are handed to the player as MP4, which plays H.264 recordings. Files it can't play show **Save…** / **Open in browser**.

More detail: [docs/images-and-videos.md](docs/images-and-videos.md).

## Troubleshooting

- **The status bar shows nothing**: the focused workspace's branch has no key. Check the branch name against the table above.
- **The tooltip says to set your Jira URL**: no site is configured yet, see [Setup](#setup).
- **"Jira refused the login (401/403)"**: the email must belong to the account that created the token. A scoped token needs `read:jira-work`.
- **"PROJ-123 was not found"**: wrong site for that project (add a line to *Other Jira sites by project key*), or your account cannot see the issue.
- **Logs**: `orca plugin logs <plugin-key>` (see `orca plugin list`).
- **Panel DevTools**: `orca plugin dev inspect`.

## Development

```text
orca-plugin.json   manifest: panel, commands, keybinding, status bar item, settings, capabilities
worker/main.mjs    trusted worker: follows focus, extracts the key, calls Jira, converts ADF to Markdown
src/panel.tsx      Jira Issue: "components" panel (no build step: Orca strips types and compiles JSX on load)
src/attachments.ts Jira Attachments: "html" panel, plain DOM, chunked downloads from the worker
src/protocol.ts    the panel <-> worker contract (request and event types)
docs/              design notes
```

Useful commands:

```bash
orca plugin types .            # write TypeScript typings into .orca/types (git-ignored)
orca plugin check .            # validate the manifest and render the panel once
orca plugin dev watch .        # load, then stream logs and reload on change
orca plugin shot <plugin> issue        # PNG of a panel as Orca draws it (also: attachments)
```

The pure helpers (`extractKey`, `normalizeBase`, `parseOverrides`, `siteFor`, `adfToMarkdown`) are exported from `worker/main.mjs`, so you can test them with plain Node.

`node tests/worker.test.mjs` runs the worker against a mocked Orca host and a mocked Jira (issue fetch, attachment chunking, cache, size cap). It needs no dependencies.

## Roadmap

- Show images inline in the description where they appear in Jira (the ADF `media` nodes).
- Transition the issue status from Orca.
- Show linked pull requests and sub-tasks.

## License

[MIT](LICENSE)
