# lineMCP

A self-hosted bridge to a **personal** LINE account: an MCP server so Claude (web, desktop, mobile, Claude Code) can read and send your messages as a custom connector, and betterLINE, a native macOS client built on the same server.

```
Claude ──HTTPS──▶ Worker  line-mcp.<your-subdomain>.workers.dev/mcp
                  │  OAuth 2.1 (DCR) — consent needs the owner passphrase
                  │  Workers VPC binding
                  ▼
           Cloudflare Tunnel (outbound only)
                  ▼
Server     server/  127.0.0.1:8790  — linejs session (ANDROIDSECONDARY slot) ──▶ LINE
                    <tailscale-ip>:8791  — desktop client API ◀── betterLINE (macOS, over Tailscale)
```

LINE has no API for personal accounts. `server/` uses [linejs](https://github.com/evex-dev/linejs), an unofficial client, logged in as a secondary device. This is against LINE's terms of service, and LINE may restrict the account. Not affiliated with LINE Corporation.

## Configure

Replace these placeholders with your own values:

| Where | Placeholder | Value |
|---|---|---|
| `worker/wrangler.jsonc` | `YOUR_KV_NAMESPACE_ID`, `YOUR_VPC_SERVICE_ID` | Your KV namespace and the Workers VPC service for your tunnel |
| `worker/src/index.ts` | `line-mcp.your-subdomain.workers.dev` | Your Worker's URL |
| `server/src/config.ts` | `line-mcp.your-subdomain.workers.dev` | Your Worker's URL, where agents upload files (or set `LINE_MCP_PUBLIC_URL` in the server's env) |
| `desktop/project.yml` | `your-tailnet.ts.net` | Your tailnet's MagicDNS domain (`tailscale status --json`, `MagicDNSSuffix`) |
| `desktop/project.yml` | `com.example` | Your bundle id prefix |
| `desktop/betterLINE/Store/Preferences.swift` | `linebox.your-tailnet.ts.net` | Default server address shown on first launch |

The commands below use `linebox` as the SSH alias of the machine running the server.

## Tools

| Tool | Notes |
|---|---|
| `line_get_status` | Session state and account |
| `line_list_chats` | Recent chats with unread counts, last message and tags. `tags` limits it to chats with any (or with `match_all_tags`, all) of those tags |
| `line_list_tags` | The tags on the owner's chats (e.g. Work, or a company, Acme) with every chat that has each, including chats quiet for over 14 days |
| `line_tag_add` / `line_tag_remove` | Add or remove tags on one or more chats. A name matching an existing tag (ignoring case and Simplified/Traditional Chinese) is that tag |
| `line_tag_rename` / `line_tag_delete` | Rename a tag on every chat (renaming onto another tag merges them), or take it off every chat, as Settings → 聊天室 does |
| `line_hide_chats` | Hide chats (隱藏聊天室). They then leave every tool too, so only the owner can unhide them, in betterLINE |
| `line_read_messages` | Chronological history with paging (`older_cursor`). LINE only serves the last 14 days to a secondary device. Stickers carry the ids `line_send_sticker` needs, and messages list their reactions. Unsent messages come back as `unsent: true` with no text, since LINE keeps none; edited ones (a LYP Premium feature) as `edited: true` with `edited_at` and the edited text |
| `line_search_contacts` | Friends and groups by name |
| `line_send_message` | E2EE text message. Limited to one send every 3 s and 20 every 10 min |
| `line_send_sticker` | A sticker seen in a chat. Shares the send limit and `sent.log` |
| `line_react` / `line_unsend` | React to a message (or `UNDO`), unsend one of the owner's own messages. Reactions share the send limit; both are logged to `sent.log` |
| `line_mark_read` | Mark a chat read up to its newest message (or a given one): sends LINE's read receipt, as opening it on the phone does |
| `line_read_receipts` | How far each other member has read; checking sends nothing |
| `line_get_media` | Opens a photo, video, voice message or file from a message Claude has read: photos come back as an image (at most 1568 px), text files as text, anything else (PDF, Excel, zip, video, …) whole as an embedded file up to 20 MB, which Claude Code saves to a local file |
| `line_forward_media` | Sends a photo, video, voice message or file from one chat to another, E2EE. Shares the send limit and `sent.log` |
| `line_create_upload` | A one-time URL to `PUT` a local file (up to 100 MB) to, for `line_send_file`. See [Uploads](#uploads) |
| `line_send_file` | Sends a text file Claude wrote (.txt .md .csv .json …) or an uploaded file, E2EE. Uploaded .jpg .png .gif go as a photo and .mp4 .mov .m4v as a video unless `as_file`; anything else as a file. Shares the send limit and `sent.log` |
| `line_archive_add` / `line_archive_remove` | Start or stop keeping a local copy of a chat. Removing keeps its messages unless `delete_messages` is set |
| `line_archive_list` | Archived chats, message counts, date range, last sync |
| `line_archive_rules` | The auto-archive rules, and for every chat active in the last 14 days whether it is archived, matches, or is skipped and why |
| `line_archive_configure` | Turn auto-archive on or off, or change the group-size limit and official-account filter |
| `line_archive_sync` | Sync archived chats now instead of waiting for the daily run |
| `line_read_archive` | Read an archived chat from the local copy, including messages older than 14 days |
| `line_search_messages` | Substring search over archived chats (works for Chinese); `tags` limits it to chats with those tags |
| `line_listen_set` / `line_listen_remove` | Register or remove a webhook for chats and/or tags; every new message from someone else in them is POSTed to it |
| `line_listen_list` | Registered listeners, their webhooks, chats and tags (with the chats that have each now) |

Reading does **not** mark chats as read and sends no read receipts.

Chats hidden in betterLINE (隱藏聊天室) are left out of every listing and search, and every tool that takes a chat id refuses them. A tag that only hidden chats have is not listed either.

Agents can do what the owner does in betterLINE except unhide a chat, which would mean showing them the chats the owner hid from them. The server instructions and tool descriptions tell agents to organise chats, react, unsend or mark read only when the owner asks.

## Hidden chats

Each Mac saves its whole copy of hidden chats with `PUT /api/organizer`. Agents hide chats with `line_hide_chats`, which the server applies at once and also keeps, with the revision each made, in `organizer.json` (the last 1,000). A Mac's save says which revision its copy is based on (`base_rev`), and the server replays every agent hide after it on top, so a Mac that was offline or mid-edit does not undo what an agent did. The reply is the result, which the Mac takes as its own.

## Tags

A chat can have any number of tags, such as Work or the company a contact works at. Tags are the only way chats are sorted: betterLINE shows the chats by tag, and agents filter and listen by tag. The owner adds and removes them in betterLINE, and agents with `line_tag_add` / `line_tag_remove`; the server instructions tell agents that tags are the owner's organisation, to change them only when the owner asks, and never to take a tag name from a LINE message.

Tags live on the server (`organizer.json`, next to hidden chats), which is the only copy both sides write. They change only through small operations — add these tags to these chats, remove them, rename a tag, delete a tag — applied one after another, so an agent's change and the desktop's change to different chats or tags both survive. The desktop's save of its hidden chats (`PUT /api/organizer`) never carries tags and leaves them alone. Every change bumps a revision number and sends an `organizer` event, so open betterLINE windows show an agent's tags right away.

Until 2026-11-10 chats could also be filed into one folder each (the app's 群組). Folders were dropped for tags: the server gave every chat in a folder a tag named after it, keeping its other tags (Work → tag "Work"), and a listener on a folder now listens to that tag. A Mac's own copy of its groups is turned into the same tags the first time a newer build starts. Older builds still get an empty `folders` list from `/api/organizer`, so they drop their groups instead of failing, and the folders they save are ignored.

## Archive

LINE serves exactly the last 14 days of history to a secondary device; older messages exist only on the phone. Chats added with `line_archive_add` are copied into `~/.local/state/line-mcp/archive.db` (SQLite, mode 600; keep it on an encrypted disk): the 14 days available at the time, then new messages once a day.

Auto-archive picks chats by rule: 1:1 chats with real people and groups of up to 10 members, never LINE official accounts (`userType = BOT`). The daily sync also adds chats that newly match. Manual adds win over the rules, and a chat removed by hand is never re-added by them.

The scheduler checks hourly and runs when the last full sync is over 24 h old, so an outage of up to two weeks catches up by itself.

## Uploads

Agents send files they have locally (a PDF, a photo) in two steps: `line_create_upload` returns `https://line-mcp…workers.dev/upload/<id>`, the agent `PUT`s the bytes there (`curl -T file '<url>'`), and passes the id to `line_send_file`. The URL needs no OAuth token: the id is 32 random characters handed out over the authorized connector, and it takes one file. The Worker streams the body to the server through Workers VPC, which keeps it owner-only in `~/.local/state/line-mcp/uploads` for an hour (so one file can go to several chats) and clears the folder on restart. Files over 100 MB are refused.

## Listeners

An agent registers a webhook for chats (`chats`), tags (`tags`, by name), or both with `line_listen_set`. Every new message someone else sends in those chats is POSTed to the webhook as JSON:

```json
{
  "text": "New LINE message in c… from Amy: lunch at noon?",
  "listener": "monitor",
  "chat_id": "c…",
  "message": { "id": "…", "from_id": "u…", "from_name": "Amy", "kind": "text", "text": "lunch at noon?", "time": "2026-10-12 16:40" }
}
```

`headers` are sent with each POST (for example `Authorization`). They are stored in full but `line_listen_set` and `line_listen_list` only show them masked, e.g. `Bearer crsr_…a1b2` (a scheme, a token prefix and the last 4 characters; a secret under 12 characters shows as `••••`). Setting an existing listener again without `headers` keeps its headers, so an agent need not resend secrets; `headers: {}` clears them. The owner's own messages are not posted, so an agent's replies don't call its webhook. A failed POST (10 s timeout) is logged and not retried. A message is posted once per listener, even if its chat is both listed and has a listened tag.

Tags are looked up when each message arrives: a chat tagged later is posted from then on, and one untagged stops, without setting the listener again. Renaming the tag (`line_tag_rename` or in betterLINE) renames it in the listener too. Hidden chats with the tag are not posted. An unknown tag is an error when the listener is set; a tag no chat has any more just stops matching, and `line_listen_list` says so. Listeners are kept in `~/.local/state/line-mcp/listeners.json`.

## Desktop client API

`server/src/clientapi.ts` serves an HTTP API for a desktop client. It is enabled only when `LINE_CLIENT_HOST` and a 32+ character `LINE_CLIENT_KEY` are set in `~/.config/line-mcp/env`. Set `LINE_CLIENT_HOST` to the server's Tailscale address so the API is reachable only over the tailnet. Every request needs `Authorization: Bearer <LINE_CLIENT_KEY>`. The macOS app in `desktop/` (below) is its client.

| Endpoint | Purpose |
|---|---|
| `GET /api/me`, `GET /api/chats` | Account and chat list (avatars, unread, mute) |
| `GET /api/contacts?q=` | Friends and groups, including ones with no messages in the last 14 days; Simplified and Traditional Chinese match |
| `GET /api/chats/:id/messages?before=` | History: LINE's 14 days (`l:` cursors), then the archive (`a:` cursors) for archived chats |
| `POST /api/chats/:id/messages`, `/sticker`, `/media?kind=&name=` | Send text, a sticker, or an E2EE image/video/audio/file |
| `GET /api/chats/:id/reads` | How far each other member has read (newest message id per member); asking sends no read receipt |
| `POST /api/chats/:id/read`, `/api/messages/:id/unsend`, `/api/messages/:id/react` | Mark read, unsend, react |
| `GET /api/media/:id?chat=&delivered=` | Decrypted media, cached owner-only in `~/.local/state/line-mcp/media-cache` (2 GB cap) |
| `GET /api/search?q=`, `GET /api/archive`, `POST /api/archive/sync` | Archive search and status |
| `GET /api/organizer`, `PUT /api/organizer` | Hidden chats and tags, kept in `~/.local/state/line-mcp/organizer.json` for the MCP tools. The PUT replaces hidden chats only, then replays agents' hides made after its `base_rev` (see [Hidden chats](#hidden-chats)) |
| `POST /api/organizer/tags` | Tag changes `{ops: [{op: "add" \| "remove", tags, chat_ids} \| {op: "rename", tags: [old], to} \| {op: "delete", tags: [old]}]}`, applied in order, all or none |
| `GET /api/events` | Server-sent events: new messages, unsends, reads, reactions, session status, organizer changes (including tags set by agents) |

To turn it off, remove `LINE_CLIENT_HOST`/`LINE_CLIENT_KEY` from the env file and `systemctl --user restart line-mcp`.

## betterLINE (macOS client)

`desktop/` is a SwiftUI app (macOS 15+) for reading and writing LINE from the Mac over this API, laid out like Messages and in Traditional Chinese: chat list with unread badges, history that continues into the archive, text with replies, stickers seen in your chats, E2EE images/video/voice/files (drop, paste or attach), reactions, unsend, archive search with Simplified/Traditional folding, live updates, and notifications you can reply to.

- **New chat (⌘N)** opens the address book: every friend and group, including ones with no messages in LINE's 14 days. The sidebar search lists matching contacts too.
- **Hidden chats**: right-click → 隱藏聊天室. A hidden chat leaves the list and search, stops counting toward the Dock badge and never notifies; Settings → 聊天室 opens or unhides it. The MCP tools leave it alone too.
- **Tags**: right-click a chat → 標籤 to tick existing tags or add a new one; a chat can have several, shown under its last message. The tag bar above the list views chats by tag: click a tag (say Work) to see only its chats, with its unread count beside it; click it again or 全部 to see every chat; ⌘-click to view several tags at once. The filter button chooses whether several tags show chats with any or all of them. The view stays across launches. Settings → 聊天室 renames or deletes a tag on every chat. Claude reads and changes the same tags (`line_list_tags`, `line_tag_add`).
- Hidden chats are saved on the server, so every Mac and the MCP tools share them. The first time a Mac connects, its hidden chats merge with the server's; after that the server's copy wins, except for changes made while offline, and agents' hides are added back on top of those.
- Tags are the server's: each Mac shows the server's copy with its own unconfirmed changes on top. A change made offline is queued (it survives quitting) and sent in order on the next connect, on top of whatever agents changed meanwhile.
- **Trackpad swipes**, as in Messages: two fingers left show every message's time; two fingers right on a bubble start a reply to it.
- **Attachments**: paste (⌘V) a screenshot, a copied image or copied files, drop files or images on the window, or use **+** → 照片與檔案…

- It reaches the server by MagicDNS name (`http://linebox.your-tailnet.ts.net:8791`). App Transport Security allows plain HTTP only to your tailnet's domain, so the bearer key cannot go out unencrypted elsewhere; a Tailscale IP is refused for the same reason.
- The client key is stored in the login keychain (item "betterLINE client key"). `project.yml` signs ad hoc, so the keychain asks again after each rebuild. Set `CODE_SIGN_IDENTITY: "Apple Development"` and `DEVELOPMENT_TEAM` to your team ID to sign with your certificate, and the keychain keeps trusting the app across rebuilds.
- Opening a chat sends LINE's read receipt, as the phone does. Turn that off in Settings → 一般 and use ⇧⌘R to mark a chat read by hand.
- Decrypted media is cached owner-only in `~/Library/Caches/<bundle id>` (2 GB cap, Settings → 一般 → 清除).
- Closing the window keeps the app running for notifications and the Dock badge; ⌘Q quits.
- The icon (`desktop/betterLINE/Resources/AppIcon.icon`, an Icon Composer file) is a chat bubble drawn as one continuous line, so it follows the system's dark, tinted and clear icon styles.

Build and install (needs Xcode and `brew install xcodegen`):

```bash
cd desktop && xcodegen generate && xcodebuild -project betterLINE.xcodeproj -scheme betterLINE -configuration Release -derivedDataPath build/DerivedData build && ditto build/DerivedData/Build/Products/Release/betterLINE.app /Applications/betterLINE.app
```

On first launch, paste the key. To copy it from the server:

```bash
ssh linebox 'grep ^LINE_CLIENT_KEY= ~/.config/line-mcp/env | cut -d= -f2-' | pbcopy
```

Run the client tests with `cd desktop && xcodebuild -project betterLINE.xcodeproj -scheme betterLINE test`. Debug builds use the bundle id suffix `.debug`, so their settings, keychain item and caches stay apart from the installed app.

## Safety rails

- linejs registers a fresh E2EE key pair when a login cannot transfer the account's keys, which breaks decryption on the primary phone. `createBaseClient` disables that, so a bad login fails instead.
- The server listens on 127.0.0.1 only and requires the `x-line-mcp-key` shared secret. It has no public hostname: the Worker reaches it through Workers VPC.
- `~/.local/state/line-mcp/storage.json` holds the session token and E2EE private keys (mode 600, atomic writes). Treat it like a password.
- Every message Claude sends, text or media, is logged in `~/.local/state/line-mcp/sent.log`.
- Only chats the owner archives are stored; everything else is fetched live and never written to disk.
- Unsent messages are removed from the archive: immediately from the push event, and again by the daily sync, which drops anything LINE no longer serves inside its 14-day window. LINE keeps serving an unsent message as an empty text message; the sync leaves those out too. Edited messages take their new text, from the push event or the daily sync.
- Only agent (MCP) sends are rate limited and logged to `sent.log`. Text goes out end-to-end encrypted; it falls back to unencrypted only for LINE official accounts, which have no E2EE keys.

## Where things live

| What | Where |
|---|---|
| Server code | `~/lineMCP` on the server, a clone of this repo on `main`; the service runs from `server/` |
| Services | `systemctl --user {status,restart} line-mcp line-mcp-tunnel` (units in `server/deploy/`) |
| Logs | `journalctl --user -u line-mcp -f` |
| Backend secret, tunnel token | `~/.config/line-mcp/{env,tunnel-token}` on the server |
| Owner passphrase | Mac login keychain, item "LINE MCP owner passphrase" |
| Worker | `worker/`, deploy with `npx wrangler deploy` |
| Desktop client | `desktop/` (XcodeGen project), key in the Mac login keychain |

Copy the owner passphrase to the clipboard:

```bash
security find-generic-password -s "LINE MCP owner passphrase" -w | pbcopy
```

## Common operations

**Run tests**: `cd server && npm test`

**Deploy server changes**: push to `main`, then pull on the server. The server only pulls; never edit code there.

```bash
ssh linebox 'cd ~/lineMCP && git pull --ff-only && cd server && npm ci --omit=dev && systemctl --user restart line-mcp'
```

**Log in** (first setup, after LINE signs the device out, or when `line_get_status` reports `logged_out`). Scan the QR code with the phone, then enter the PIN it shows:

```bash
ssh -t linebox 'systemctl --user stop line-mcp && cd ~/lineMCP/server && npm run login -- --force; systemctl --user start line-mcp'
```

**Phone LINE stops showing notifications**: the server's push listener keeps the secondary device online around the clock, so the account setting `notificationDisabledWithSub` must stay off. When it is on, LINE skips the phone while a secondary device is in use, and this one is never idle. The setting is LINE PC's 「登入電腦版時停用智慧手機版提醒功能」 (on by default). Check it with `talk.getSettings()` and turn it off with `talk.updateSettingsAttributes2({ reqSeq: 0, settings: { notificationDisabledWithSub: false }, attributesToUpdate: ["NOTIFICATION_DISABLED_WITH_SUB"] })`, or untick that box in official LINE for Mac/PC.

**Revoke everything at once**: remove the "Android" secondary device in LINE on the phone (Settings → Account → Devices), or `systemctl --user stop line-mcp` on the server.

**Rotate the owner passphrase**: generate a new one, store it in the keychain, and `npx wrangler secret put OWNER_PASSPHRASE_SHA256` with its SHA-256 hex.
