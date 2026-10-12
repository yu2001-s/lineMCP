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
| `desktop/project.yml` | `your-tailnet.ts.net` | Your tailnet's MagicDNS domain (`tailscale status --json`, `MagicDNSSuffix`) |
| `desktop/project.yml` | `com.example` | Your bundle id prefix |
| `desktop/betterLINE/Store/Preferences.swift` | `linebox.your-tailnet.ts.net` | Default server address shown on first launch |

The commands below use `linebox` as the SSH alias of the machine running the server.

## Tools

| Tool | Notes |
|---|---|
| `line_get_status` | Session state and account |
| `line_list_chats` | Recent chats with unread counts and last message |
| `line_read_messages` | Chronological history with paging (`older_cursor`). LINE only serves the last 14 days to a secondary device |
| `line_search_contacts` | Friends and groups by name |
| `line_send_message` | E2EE text message. Limited to one send every 3 s and 20 every 10 min |
| `line_archive_add` / `line_archive_remove` | Start or stop keeping a local copy of a chat. Removing keeps its messages unless `delete_messages` is set |
| `line_archive_list` | Archived chats, message counts, date range, last sync |
| `line_archive_rules` | The auto-archive rules, and for every chat active in the last 14 days whether it is archived, matches, or is skipped and why |
| `line_archive_configure` | Turn auto-archive on or off, or change the group-size limit and official-account filter |
| `line_archive_sync` | Sync archived chats now instead of waiting for the daily run |
| `line_read_archive` | Read an archived chat from the local copy, including messages older than 14 days |
| `line_search_messages` | Substring search over archived chats (works for Chinese) |

Reading does **not** mark chats as read and sends no read receipts.

## Archive

LINE serves exactly the last 14 days of history to a secondary device; older messages exist only on the phone. Chats added with `line_archive_add` are copied into `~/.local/state/line-mcp/archive.db` (SQLite, mode 600; keep it on an encrypted disk): the 14 days available at the time, then new messages once a day.

Auto-archive picks chats by rule: 1:1 chats with real people and groups of up to 10 members, never LINE official accounts (`userType = BOT`). The daily sync also adds chats that newly match. Manual adds win over the rules, and a chat removed by hand is never re-added by them.

The scheduler checks hourly and runs when the last full sync is over 24 h old, so an outage of up to two weeks catches up by itself.

## Desktop client API

`server/src/clientapi.ts` serves an HTTP API for a desktop client. It is enabled only when `LINE_CLIENT_HOST` and a 32+ character `LINE_CLIENT_KEY` are set in `~/.config/line-mcp/env`. Set `LINE_CLIENT_HOST` to the server's Tailscale address so the API is reachable only over the tailnet. Every request needs `Authorization: Bearer <LINE_CLIENT_KEY>`. The macOS app in `desktop/` (below) is its client.

| Endpoint | Purpose |
|---|---|
| `GET /api/me`, `GET /api/chats` | Account and chat list (avatars, unread, mute) |
| `GET /api/contacts?q=` | Friends and groups, including ones with no messages in the last 14 days; Simplified and Traditional Chinese match |
| `GET /api/chats/:id/messages?before=` | History: LINE's 14 days (`l:` cursors), then the archive (`a:` cursors) for archived chats |
| `POST /api/chats/:id/messages`, `/sticker`, `/media?kind=&name=` | Send text, a sticker, or an E2EE image/video/audio/file |
| `POST /api/chats/:id/read`, `/api/messages/:id/unsend`, `/api/messages/:id/react` | Mark read, unsend, react |
| `GET /api/media/:id?chat=&delivered=` | Decrypted media, cached owner-only in `~/.local/state/line-mcp/media-cache` (2 GB cap) |
| `GET /api/search?q=`, `GET /api/archive`, `POST /api/archive/sync` | Archive search and status |
| `GET /api/events` | Server-sent events: new messages, unsends, reads, reactions, session status |

To turn it off, remove `LINE_CLIENT_HOST`/`LINE_CLIENT_KEY` from the env file and `systemctl --user restart line-mcp`.

## betterLINE (macOS client)

`desktop/` is a SwiftUI app (macOS 15+) for reading and writing LINE from the Mac over this API, laid out like Messages and in Traditional Chinese: chat list with unread badges, history that continues into the archive, text with replies, stickers seen in your chats, E2EE images/video/voice/files (drop, paste or attach), reactions, unsend, archive search with Simplified/Traditional folding, live updates, and notifications you can reply to.

- **New chat (⌘N)** opens the address book: every friend and group, including ones with no messages in LINE's 14 days. The sidebar search lists matching contacts too.
- **Groups**: right-click a chat → 移到群組 to file it under a collapsible sidebar section. Groups are kept on this Mac only.
- **Hidden chats**: right-click → 隱藏聊天室. A hidden chat leaves the list and search, stops counting toward the Dock badge and never notifies; Settings → 聊天室 opens or unhides it.
- **Trackpad swipes**, as in Messages: two fingers left show every message's time; two fingers right on a bubble start a reply to it.
- **Attachments**: paste (⌘V) a screenshot, a copied image or copied files, drop files or images on the window, or use **+** → 照片與檔案…

- It reaches the server by MagicDNS name (`http://linebox.your-tailnet.ts.net:8791`). App Transport Security allows plain HTTP only to your tailnet's domain, so the bearer key cannot go out unencrypted elsewhere; a Tailscale IP is refused for the same reason.
- The client key is stored in the login keychain (item "betterLINE client key"). `project.yml` signs ad hoc, so the keychain asks again after each rebuild. Set `CODE_SIGN_IDENTITY: "Apple Development"` and `DEVELOPMENT_TEAM` to your team ID to sign with your certificate, and the keychain keeps trusting the app across rebuilds.
- Opening a chat sends LINE's read receipt, as the phone does. Turn that off in Settings → 一般 and use ⇧⌘R to mark a chat read by hand.
- Decrypted media is cached owner-only in `~/Library/Caches/<bundle id>` (2 GB cap, Settings → 一般 → 清除).
- Closing the window keeps the app running for notifications and the Dock badge; ⌘Q quits.
- The app ships without an icon. To add one, put an Icon Composer file at `desktop/betterLINE/Resources/AppIcon.icon` and set `ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon` in `project.yml`.

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
- Every sent message is logged in `~/.local/state/line-mcp/sent.log`.
- Only chats the owner archives are stored; everything else is fetched live and never written to disk.
- Unsent messages are removed from the archive: immediately from the push event, and again by the daily sync, which drops anything LINE no longer serves inside its 14-day window.
- Only agent (MCP) sends are rate limited and logged to `sent.log`. Text goes out end-to-end encrypted; it falls back to unencrypted only for LINE official accounts, which have no E2EE keys.

## Where things live

| What | Where |
|---|---|
| Server code | `~/lineMCP/server` on the server (deployed from `server/` here with rsync) |
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

**Deploy server changes**

```bash
rsync -az --exclude node_modules server/ linebox:lineMCP/server/ && ssh linebox 'cd ~/lineMCP/server && npm ci --omit=dev && systemctl --user restart line-mcp'
```

**Log in** (first setup, after LINE signs the device out, or when `line_get_status` reports `logged_out`). Scan the QR code with the phone, then enter the PIN it shows:

```bash
ssh -t linebox 'systemctl --user stop line-mcp && cd ~/lineMCP/server && npm run login -- --force; systemctl --user start line-mcp'
```

**Phone LINE stops showing notifications**: the server's push listener keeps the secondary device online around the clock, so the account setting `notificationDisabledWithSub` must stay off. When it is on, LINE skips the phone while a secondary device is in use, and this one is never idle. The setting is LINE PC's 「登入電腦版時停用智慧手機版提醒功能」 (on by default). Check it with `talk.getSettings()` and turn it off with `talk.updateSettingsAttributes2({ reqSeq: 0, settings: { notificationDisabledWithSub: false }, attributesToUpdate: ["NOTIFICATION_DISABLED_WITH_SUB"] })`, or untick that box in official LINE for Mac/PC.

**Revoke everything at once**: remove the "Android" secondary device in LINE on the phone (Settings → Account → Devices), or `systemctl --user stop line-mcp` on the server.

**Rotate the owner passphrase**: generate a new one, store it in the keychain, and `npx wrangler secret put OWNER_PASSPHRASE_SHA256` with its SHA-256 hex.
