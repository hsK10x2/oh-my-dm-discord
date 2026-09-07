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

## Tests

21 tests added (`test/discord-dom.test.ts`, `test/discord-web.test.ts`, plus an
N-connector layout case in `test/text-layout.test.ts`); 124 pass.

## Account risk

Unchanged from upstream in spirit, but worth restating. Discord's Terms of
Service prohibit automating a user account outside the OAuth2/bot API — a
"self-bot" — and violations can end in account termination. This connector is
exactly that, because the official routes cannot read your own DMs. Bulk
messaging, automatic retries and bypass mechanisms remain deliberately absent.
