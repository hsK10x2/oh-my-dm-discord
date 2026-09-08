# Changes from upstream

This repository is a modified copy of
[stacking-money-forever/oh-my-dm](https://github.com/stacking-money-forever/oh-my-dm)
by Hyunwoo Gu (구현우), used under the Apache License 2.0. The original `LICENSE`
and `NOTICE` are retained; `NOTICE` records the modification as Apache-2.0 §4(b)
requires. Not affiliated with or endorsed by the original author.

Baseline: upstream `v0.7.1` (commit `e15c4ac`).

---

## Added — Discord DM connector

`src/connectors/discord-dom.ts`, `src/connectors/discord-web.ts`

Reads and sends direct messages on `discord.com/channels/@me` through the
Playwright Chromium that already ships with the project, so no new dependency
was added. It follows the same shape as the Instagram connector: a persistent
browser profile, a one-time manual login (`oh-my-dm login discord`), and an
event-driven refresh driven by DOM mutations and gateway websocket frames.

**Why browser automation and not an API.** Both official routes were checked
first and neither can back a DM client:

| Approach | Read own DMs | Send | Verdict |
| --- | --- | --- | --- |
| Bot gateway API | No — a bot only sees DMs sent *to it* | Partial | Cannot meet the requirement |
| Local RPC (`\\.\pipe\discord-ipc-0`) | Read-only, and needs an approved app | **No send command exists** | Cannot meet the requirement |
| Browser automation | Yes | Yes | Used here |

The RPC pipe was confirmed present on a live machine; the protocol simply has no
message-send command. See **Account risk** below — this route is a ToS problem,
not a technical one.

**Design notes.**

- *Selectors never depend on hashed CSS class names.* Discord re-hashes them on
  every deploy. The connector keys off the id prefixes and data attributes that
  have been stable for years — `[data-list-id="chat-messages"]`,
  `[id^="chat-messages-"]`, `[id^="message-content-"]`, `[id^="message-username-"]`,
  `[id^="message-reply-context-"]`, `time[datetime]`, `[role="textbox"]`.
  The one exception is the `systemMessage` class *prefix*, which is documented
  inline; Discord appends a per-deploy hash but keeps the semantic prefix.
- *History merges by id, not by position.* Discord's own row id carries the
  message snowflake, so unlike the Instagram connector — which has to
  positionally align two DOM windows — this one merges exactly. Snowflakes are
  monotonic, so a re-read row below the oldest kept message is history fetched by
  scrolling and everything else is new traffic.
- *Grouped messages inherit their author.* Discord hides the author header on
  consecutive messages from the same person. Rows arrive in document order, which
  makes carrying the last header forward exact rather than heuristic.

## Added — Discord server channels

`src/connectors/discord-dom.ts`, `src/connectors/discord-web.ts`

The connector originally covered direct messages only. It now also lists and
opens server text channels, titled the way a Discord user refers to them —
`인프 모둠 #일반`.

**Servers are loaded lazily.** Discord renders only the currently selected
server's channel list, so enumerating every channel means navigating to each
server in turn. Doing that up front would stall startup behind one full render
per server, so `loadMoreConversations()` pulls in one more server per call —
which is what the TUI already invokes when you scroll past the end of the list.

**Collapsed folders are expanded first.** A server dragged into a folder is
hidden from the rail until the folder is opened, so a plain rail read misses
most of an account's servers — on the account this was built against, three of
the six rail entries were folders holding fifteen-plus servers between them.
The first `loadMoreConversations()` call clicks every collapsed folder open.

**Notes on the DOM.** The rail is built from `div`s rather than links, so it is
keyed by `[data-list-item-id^="guildsnav___"]`; a real server is the entry whose
id is a snowflake, which is what separates it from a folder or one of the fixed
buttons. Server names come from `data-dnd-name`, and channel names from the
row's `aria-label` — the row's text content also carries its hover actions.

## Changed — the Discord list is sectioned, loads servers on its own, and shows unread

`src/domain.ts`, `src/connectors/discord-dom.ts`, `src/connectors/discord-web.ts`,
`src/ui/app.tsx`

Three things made the first cut of server support unpleasant to actually use.

**Servers only appeared if you scrolled to the very end.** `loadMoreConversations()`
is the TUI's "I reached the bottom" signal, which is a reasonable place to fetch
*more* of something — but it is a terrible place to put the only copy of most of
the sidebar. With nineteen DMs ahead of them, the servers may as well not have
existed. A background sweep now walks every server once the app is up,
republishing after each so the list fills in progressively.

The sweep runs on a page of its own. Harvesting means navigating to each server
in turn, because Discord only renders the channel list of the one currently
open; doing that on the visible page would yank the view around. Guarding
against that by stopping whenever a conversation was open — the first attempt —
was worse: you open a conversation within seconds of arriving, so the sweep died
there and all but the first server or two never loaded. A second page shares the
session, navigates freely, and leaves the visible page alone. On the account
this was built against it now reaches every server while a conversation stays
open.

**Servers are opened by clicking the rail, not by navigating to a URL.**
`page.goto("/channels/<id>")` reloads the whole application for each server:
measured at roughly nine seconds each against under one for a click, and a
reload sometimes settled with the channel list still empty, so the slower path
was also the one that silently lost channels. Sweeping 21 servers went from
about 102 seconds to 18, and picked up two servers and seven channels that the
reload had been dropping.

**Everything was one flat list.** `Conversation` gained an optional `group`, and
the conversation view draws a heading whenever it changes. Discord puts direct
messages in one section and each server in its own; connectors with a single
flat list set nothing and render exactly as before. The row itself is now just
`#일반` — the server name is the heading above it rather than a prefix repeated
on every line.

**Unread was never detected.** The previous check looked for a `numberBadge` or
`unread` class on the row. Measuring the live DOM showed why that finds nothing:
the only badge element on a DM row is the 14×14 presence dot, and it carries no
text; unread is communicated purely by drawing the name at full contrast while
read rows are dimmed. `markUnreadByContrast` therefore derives the rule from the
list itself — the colour most rows share is the read colour, and a row standing
further from the background than that is unread. Judging against the background
rather than an absolute brightness is what makes it hold in both themes, and
self-calibrating on the majority means a palette change does not break it.

On the account this was built against the result matches Discord's own count
exactly: two unread, both in servers, which is what `document.title` reported as
`(2) Discord`.

## Changed — KakaoTalk is registered only on macOS

`src/cli.tsx`

Upstream registers the KakaoTalk connector unconditionally, which on Windows
produces a connector that can never work. It is now registered only on `darwin`,
and `oh-my-dm doctor` explains the exclusion. **The macOS path is untouched.**

The reason is not a missing implementation — it is that the data is not there.
Measured against KakaoTalk for Windows 26.7.1.5263:

| Control | `WM_GETTEXTLENGTH` | UI Automation children | MSAA content |
| --- | --- | --- | --- |
| `RICHEDIT50W` (composer) | 11 | — | `role=10` |
| `EVA_VH_ListControl_Dblclk` (messages) | **0** | **0** | `accChild(1)` → `E_INVALIDARG` |
| `ChatRoomListCtrl` (room list) | 27 *(the control's own name string)* | **0** | none |

Both the message list and the room list are fully owner-drawn EVA controls that
expose no text through either accessibility API. macOS works because the macOS
app does expose its chat content through the Accessibility API; the Windows app
is a separate codebase where that premise does not hold. Sending would be
possible (`RICHEDIT50W` + `WM_SETTEXT`), but a messenger that cannot show a
conversation is not worth shipping.

## Changed — the TUI takes any number of connectors

`src/ui/app.tsx`, `src/ui/text-layout.ts`, `src/ui/theme.ts`, `src/ui/i18n.ts`

The conversation view hard-coded exactly two providers: a `"instagram" |
"kakaotalk"` union, a `Tab` key that toggled between them, `I`/`K` row marks, and
a tab strip 9 or 25 columns wide. Tabs, colours, row marks and tab width are now
derived from the connectors the unified connector actually reports, so adding a
connector needs no UI change. `getConversationLayout` keeps its old two-provider
widths when called without a provider list.

The login prompt was Instagram-specific (`instagramLoginRequired`); it is now
`providerLoginRequired(label, id)` and names whichever connector needs a login.

## Added — `src/browser/profile.ts`

`isInstagramProfileLockError` and `cloneInstagramProfile` were generic despite
their names. They moved to `src/browser/profile.ts` as `isProfileLockError` and
`cloneBrowserProfile`; the Instagram module re-exports the original names so
existing callers and tests are unaffected.

## Fixed — `oh-my-dm login` crashed instead of reporting the failure

`src/connectors/discord-web.ts`, `src/cli.tsx`

A refresh scheduled during startup could fire *after* `start()` had failed and
torn the page down. `performRefresh` then reached `requirePage()`, threw, and
emitted an `error` event. Because the `login` command attaches no `error`
listener, Node turned that into an unhandled-`error` process crash — which
replaced the real failure with an unrelated stack trace.

Three fixes: `performRefresh` treats a missing page as a no-op instead of an
error, `startBrowser` disarms the pending timer on every teardown path, and the
`login` command attaches an `error` listener so failures print as messages.

## Fixed — a signed-out account reported itself as connected

`src/connectors/discord-web.ts`, `src/connectors/discord-dom.ts`

`discord.com/channels/@me` renders for two to three seconds before Discord's
client-side router decides the session is invalid and pushes `/login`, so a URL
check alone reports a signed-out account as signed in. Discord also deletes
`window.localStorage` from the page, so the token cannot be read the way the
Instagram connector reads its session cookie. The connector now waits for a piece
of the signed-in shell and reports `starting` until it appears.

## Fixed — own messages were not marked as "나"

`src/connectors/discord-dom.ts`

Identity was resolved from the account-panel avatar's user id. An account with no
custom avatar renders a bundled `/assets/*.png` there, so there is no id to read
and every message the user sent was attributed to their display name instead.
The panel's display name is now read as a fallback, and a confirmed send teaches
the connector its own name as a third source.

## Fixed — a re-read could erase a known sender

`src/connectors/discord-dom.ts`

Scrolling can push a group header out of view, so re-reading the topmost row
yields a message with no author. The id-keyed merge overwrote the stored message
wholesale, downgrading an already-resolved sender to `unknown`. The merge now
keeps the known sender.

## Fixed — system notices were read as anonymous messages

`src/connectors/discord-dom.ts`

Discord notices such as a group rename carry a normal `message-content` element
but no author header, so they were classified as ordinary text from `unknown`.
They are now detected and typed as `system`.

---

## Fixed — a guild channel could not be opened or read

`src/connectors/discord-web.ts`

`channelIdFromUrl` matched only `/channels/@me/<id>`, so once server channels
existed the connector could route to one but then failed to recognise it:
no active conversation, no message history, and no send target. It now shares
the DM/guild href parser with the rest of the module.

Two smaller ones found while verifying the same path: returning from a server
left the app shell mid-render, and `performRefresh()` is a no-op in that
window, so a round's channels reached the snapshot only on the next call; and
the channel name was taken as everything before a trailing parenthesis, which
kept the localized qualifiers Discord appends after the channel type
("토스 (채팅 채널), 비공개 채널").

## Tests

31 tests added (`test/discord-dom.test.ts`, `test/discord-web.test.ts`, plus an
N-connector layout case in `test/text-layout.test.ts`); 134 pass.

## Account risk

Unchanged from upstream in spirit, but worth restating. Discord's Terms of
Service prohibit automating a user account outside the OAuth2/bot API — a
"self-bot" — and violations can end in account termination. This connector is
exactly that, because the official routes cannot read your own DMs. Bulk
messaging, automatic retries and bypass mechanisms remain deliberately absent.
