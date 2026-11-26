# Images and videos in the Jira Issue panel

**Short answer: yes, it is possible, but not with the current `"ui": "components"` panel. It needs an HTML ("isolated frame") panel, and the worker must download the attachments for it.**

Findings come from Orca 1.4.277: its plugin typings (`orca plugin types`) and the frame security policy inside the app bundle.

## Why the current panel cannot do it

The panel uses Orca's component catalog (`"ui": "components"`). Its typings say:

- `Image`: *"An image file in the plugin (`assets/logo.png`); never a URL."*
- `Markdown`: *"images must be plugin files."*

The catalog has no video component. Jira attachments are remote and need authentication, so this panel type cannot show them. Today the ADF converter replaces `mediaSingle` / `mediaGroup` nodes with *"(attachment – open the issue in Jira to see it)"*.

## What does work: an HTML panel

A panel declared **without** `"ui"` (an HTML `entry`) runs in an isolated frame with this policy:

```
img-src 'self' data: blob:;  media-src 'self' data: blob:;  connect-src 'self' data: blob:
```

The frame's session also blocks all network access, so `<img src="https://…atlassian.net/…">` will not load. But `blob:` and `data:` URLs are allowed for both `<img>` and `<video>`. That gives this design:

```
panel (HTML frame)                       worker (trusted, has fetch + the API token)
------------------                       -------------------------------------------
plugin.request('jira.attachment',  --->  GET /rest/api/3/attachment/content/{id}
  { id, offset })                           (or /attachment/thumbnail/{id})
                                    <---  { mimeType, size, base64 chunk, next offset }
new Blob(chunks, { type }) → URL.createObjectURL → <img> / <video controls>
```

1. Request the `attachment` field too (`fields=…,attachment`), and send the panel a list of `{ id, filename, mimeType, size, thumbnailUrl }`.
2. The ADF `media` nodes refer to attachments by id and filename, so inline images can be placed where they appear in the description.
3. The panel asks the worker for the bytes. The worker downloads them with the same Basic or gateway auth it already uses, and answers in base64 chunks.

## Limits that shape the design

| Limit (from Orca's bridge) | Value | Consequence |
| --- | --- | --- |
| Worker → panel answer per request | 1 MiB | about 750 KB of raw data per chunk after base64 |
| Panel requests | 120 per 10 s | about 9 MB per 10 s at best, shared with other calls |
| Worker → panel post | 256 KiB | do not push media; let the panel pull it |

What that means in practice:

- **Images and screenshots**: fine. Load thumbnails (`/rest/api/3/attachment/thumbnail/{id}`, small) eagerly, and the full image on click.
- **Short videos (a few MB)**: fine, loaded on demand when the person presses play.
- **Large videos (50 MB+)**: technically possible with chunking, but slow and it uses up the request budget. Show a poster or thumbnail with **Download** (`files.saveAs`, up to 64 MiB) or **Open in Jira** instead, with a configurable size cap.
- Cache downloaded bytes in the worker (keyed by attachment id) so switching workspaces back and forth does not download again. Free them in the panel with `URL.revokeObjectURL`.

## Cost of switching

The HTML panel loses the component catalog (Badge, KeyValue, Markdown, theming for free), so the panel UI would have to be rebuilt in plain HTML/CSS with Orca's `--orca-*` theme variables. Options:

1. **Replace** the components panel with an HTML panel that renders everything, media included. One panel, most work.
2. **Add a second panel**, e.g. *Jira Attachments*, as an HTML gallery, and keep the current panel as is. Less risk, and media stays out of the way until wanted. **Recommended first step.**

A good order: thumbnails of image attachments first, then full-size images, then video with a size cap, then inline placement in the description.
