import type { ChatMessage, Conversation, MessageReference } from "../domain.js";
import { normalizeMessageContent } from "../message-content.js";

// Discord ships hashed CSS class names that change on every deploy, so nothing
// here may depend on them. The selectors below use the id prefixes and data
// attributes Discord has kept stable for years, plus ARIA roles.
export const DM_ROW_SELECTOR = 'nav a[href^="/channels/@me/"]';
export const MESSAGE_LIST_SELECTOR = '[data-list-id="chat-messages"]';
export const MESSAGE_ROW_SELECTOR = '[data-list-id="chat-messages"] > li';
export const COMPOSER_SELECTOR = 'form [role="textbox"][contenteditable="true"]';

export const ME = "나";

export interface RawDiscordConversation {
  href: string;
  title: string;
  preview?: string;
  unreadHint?: boolean;
}

export interface RawDiscordMessage {
  rowId: string;
  text: string;
  /** Author from the group header. Absent on grouped follow-up messages. */
  sender?: string | null;
  authorId?: string | null;
  timestamp?: string | null;
  edited?: boolean;
  system?: boolean;
  replySender?: string | null;
  replyText?: string | null;
}

export function channelIdFromHref(href: string): string | undefined {
  return href.match(/\/channels\/@me\/(\d+)/)?.[1];
}

/**
 * `chat-messages-<channelId>-<messageId>` is Discord's own row id. Using the
 * snowflake it carries means history merging never has to guess whether two
 * rows are the same message, which is what the Instagram connector must do.
 */
export function messageIdFromRowId(rowId: string): string | undefined {
  return rowId.match(/^chat-messages-(?:\d+-)?(\d+)$/)?.[1];
}

export function normalizeDiscordConversation(
  raw: RawDiscordConversation,
): Conversation | undefined {
  const id = channelIdFromHref(raw.href);
  if (!id) return undefined;
  const title = collapseWhitespace(raw.title);
  if (!title) return undefined;
  const preview = collapseWhitespace(raw.preview ?? "");
  return {
    id,
    href: raw.href,
    title,
    ...(preview ? { preview } : {}),
    unread: Boolean(raw.unreadHint),
  };
}

/**
 * Identity of the signed-in account. Discord only exposes an id in the
 * account panel when the user has a custom avatar, so the display name is
 * carried alongside it as the fallback match.
 */
export interface DiscordIdentity {
  id?: string | null;
  name?: string | null;
}

export function normalizeDiscordMessage(
  channelId: string,
  raw: RawDiscordMessage,
  index: number,
  currentUser: DiscordIdentity = {},
): ChatMessage | undefined {
  const content = normalizeMessageContent(collapseWhitespace(raw.text));
  if (!content) return undefined;

  const rawSender = collapseWhitespace(raw.sender ?? "");
  // A system notice has no author of its own; naming it "unknown" would read
  // as a message whose sender could not be resolved.
  const sender = raw.system
    ? "system"
    : isOwnAuthor(raw.authorId, rawSender, currentUser)
      ? ME
      : rawSender || "unknown";
  const replyTo: MessageReference | undefined = raw.replySender || raw.replyText
    ? {
        ...(raw.replySender
          ? {
              sender: isOwnAuthor(null, collapseWhitespace(raw.replySender), currentUser)
                ? ME
                : collapseWhitespace(raw.replySender),
            }
          : {}),
        ...(raw.replyText ? { text: collapseWhitespace(raw.replyText) } : {}),
      }
    : undefined;

  const kind = raw.system
    ? ("system" as const)
    : replyTo && content.kind === "text"
      ? ("reply" as const)
      : content.kind;
  const edited = raw.edited || content.edited || undefined;

  return {
    id: messageIdFromRowId(raw.rowId) ?? `${channelId}:${index}`,
    threadId: channelId,
    kind,
    sender,
    text: content.text,
    ...(raw.timestamp ? { timestamp: raw.timestamp } : {}),
    ...(edited ? { edited: true } : {}),
    ...(replyTo ? { replyTo } : {}),
  };
}

function isOwnAuthor(
  authorId: string | null | undefined,
  sender: string,
  currentUser: DiscordIdentity,
): boolean {
  if (currentUser.id && authorId && authorId === currentUser.id) return true;
  return Boolean(currentUser.name && sender && sender === currentUser.name);
}

/**
 * Discord hides the author header on consecutive messages from the same
 * person, so a grouped row carries no sender of its own. Rows arrive in
 * document order, which makes carrying the last header forward exact rather
 * than heuristic.
 */
export function inheritDiscordGroupedSenders(
  rawMessages: RawDiscordMessage[],
): RawDiscordMessage[] {
  let sender: string | null | undefined;
  let authorId: string | null | undefined;
  return rawMessages.map((message) => {
    if (message.system) return message;
    if (message.sender || message.authorId) {
      sender = message.sender;
      authorId = message.authorId;
      return message;
    }
    return {
      ...message,
      ...(sender ? { sender } : {}),
      ...(authorId ? { authorId } : {}),
    };
  });
}

/**
 * Discord message ids are snowflakes, so history merges by id instead of the
 * positional matching the Instagram connector needs. Existing rows keep their
 * position; a re-read row is replaced in place so edits and late-resolved
 * authors land without duplicating the message.
 */
export function mergeDiscordMessages(
  existing: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] {
  if (existing.length === 0) return incoming;
  if (incoming.length === 0) return existing;

  const incomingById = new Map(incoming.map((message) => [message.id, message]));
  const existingIds = new Set(existing.map((message) => message.id));
  const merged = existing.map((message) => {
    const update = incomingById.get(message.id);
    if (!update) return message;
    // The topmost visible row can lose its group header to scrolling, which
    // makes a re-read look like an anonymous message. Never let that erase a
    // sender we already resolved.
    return update.sender === "unknown" && message.sender !== "unknown"
      ? { ...update, sender: message.sender }
      : update;
  });

  const fresh = incoming.filter((message) => !existingIds.has(message.id));
  if (fresh.length === 0) return merged;

  // Snowflakes are monotonic, so anything below the oldest kept row is history
  // fetched by scrolling up and everything else is new traffic.
  const oldestKept = merged[0]?.id ?? "";
  const older = fresh.filter((message) => isOlderSnowflake(message.id, oldestKept));
  const newer = fresh.filter((message) => !isOlderSnowflake(message.id, oldestKept));
  return [...older, ...merged, ...newer];
}

function isOlderSnowflake(candidate: string, reference: string): boolean {
  if (!/^\d+$/.test(candidate) || !/^\d+$/.test(reference)) return false;
  return candidate.length === reference.length
    ? candidate < reference
    : candidate.length < reference.length;
}

export function mergeDiscordConversations(
  existing: Conversation[],
  incoming: Conversation[],
): Conversation[] {
  const incomingById = new Map(incoming.map((item) => [item.id, item]));
  const merged = existing.map((item) => incomingById.get(item.id) ?? item);
  const existingIds = new Set(existing.map((item) => item.id));
  for (const item of incoming) {
    if (!existingIds.has(item.id)) merged.push(item);
  }
  return merged;
}

function collapseWhitespace(value: string): string {
  return value.replaceAll(" ", " ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Browser-context callbacks.
//
// These run inside Chromium via evaluate/evaluateAll. Keep every one of them
// top-level and self-contained: helpers declared inside an evaluate callback
// get rewritten by tsx/esbuild to call a module-scoped __name that does not
// exist in the page.
// ---------------------------------------------------------------------------

export function readDiscordConversationRows(elements: Element[]): RawDiscordConversation[] {
  return elements.map((element) => {
    const anchor = element as HTMLAnchorElement;
    const row = anchor.closest("li") ?? anchor;
    const parts = [
      ...new Set(
        [...row.querySelectorAll("div, span")]
          .map((part) => {
            const node = part as HTMLElement;
            // Only leaf text nodes; container innerText repeats every child.
            return node.children.length === 0
              ? (node.textContent ?? "").replaceAll(" ", " ").trim()
              : "";
          })
          .filter((part) => part.length > 0),
      ),
    ];
    const label = anchor.getAttribute("aria-label") ?? "";
    return {
      href: anchor.getAttribute("href") ?? "",
      title: parts[0] ?? label,
      preview: parts.slice(1).join(" · ") || undefined,
      // Discord renders the unread pill as a sibling of the link and mirrors
      // the count into the tab title; the badge element is the reliable half.
      unreadHint:
        row.querySelector('[class*="numberBadge"], [class*="unread"]') !== null ||
        /\bunread\b|읽지 않/i.test(label),
    };
  });
}

export function readDiscordMessageRows(elements: Element[]): RawDiscordMessage[] {
  return elements.map((element) => {
    const row = element as HTMLElement;
    const rowId = row.getAttribute("id") ?? "";
    const contentNode = row.querySelector('[id^="message-content-"]');
    const usernameNode = row.querySelector('[id^="message-username-"]');
    const senderNode = usernameNode?.querySelector("span") ?? usernameNode;
    const timeNode = row.querySelector("time[datetime]");
    const replyNode = row.querySelector('[id^="message-reply-context-"]');
    const avatarNode = row.querySelector('img[src*="/avatars/"], img[src*="/embed/avatars/"]');
    const avatarSource = avatarNode?.getAttribute("src") ?? "";
    // Notices such as a group rename or a pin carry a normal message-content
    // element but no author header, so without this marker they read as an
    // ordinary message from "unknown". Discord suffixes a per-deploy hash onto
    // the class name but keeps the semantic prefix.
    const isSystem =
      contentNode === null || row.querySelector('[class*="systemMessage"]') !== null;

    return {
      rowId,
      // A system row still exposes its text through message-content, which
      // reads better than the whole row (that would include the timestamp).
      text: (
        (contentNode as HTMLElement | null)?.innerText ??
        contentNode?.textContent ??
        row.textContent ??
        ""
      ).replaceAll(" ", " ").trim(),
      sender: (senderNode as HTMLElement | null)?.textContent?.trim() ?? null,
      authorId: avatarSource.match(/\/avatars\/(\d+)\//)?.[1] ?? null,
      timestamp: timeNode?.getAttribute("datetime") ?? null,
      edited: row.querySelector('[class*="edited"]') !== null,
      system: isSystem,
      replySender:
        replyNode?.querySelector('[id^="message-username-"]')?.textContent?.trim() ?? null,
      replyText:
        replyNode?.querySelector('[id^="message-content-"]')?.textContent?.trim() ?? null,
    };
  });
}

/**
 * Reads the signed-in account from the panel pinned to the bottom-left of the
 * sidebar. Geometry locates the panel because its `aria-label` is localized
 * and its class names are hashed per deploy. An account with no custom avatar
 * renders a bundled `/assets/*.png` there and therefore exposes no id at all,
 * so the display name is read as well and used as the fallback match.
 */
export function readDiscordCurrentUser(): { id: string | null; name: string | null } {
  const panel = [...document.querySelectorAll("section")].find((section) => {
    const rect = section.getBoundingClientRect();
    return (
      rect.left < 100 &&
      rect.width > 0 &&
      rect.width < 500 &&
      rect.top > (window.innerHeight || 800) * 0.7
    );
  });
  if (!panel) return { id: null, name: null };

  const avatar = panel.querySelector('img[src*="/avatars/"]');
  const id = (avatar?.getAttribute("src") ?? "").match(/\/avatars\/(\d+)\//)?.[1] ?? null;

  const named = panel.querySelector('[data-text-variant^="text-md"]');
  let name = (named?.textContent ?? "").replaceAll("\u00a0", " ").trim();
  if (!name) {
    for (const node of panel.querySelectorAll("div, span")) {
      if (node.children.length > 0) continue;
      const text = (node.textContent ?? "").replaceAll("\u00a0", " ").trim();
      if (text) { name = text; break; }
    }
  }
  return { id, name: name || null };
}

export interface DiscordPageState {
  path: string;
  loginPage: boolean;
  appReady: boolean;
}

/**
 * `/channels/@me` renders before Discord's client-side router decides the
 * session is invalid and pushes `/login`, so the URL alone reports a signed
 * out account as signed in for the first few seconds. Discord also deletes
 * `window.localStorage`, which rules out reading the token the way the
 * Instagram connector reads its session cookie. Waiting for a piece of the
 * signed-in shell is the signal that survives both.
 */
export function readDiscordPageState(): DiscordPageState {
  const path = location.pathname;
  return {
    path,
    loginPage: /^\/(?:login|register)/.test(path),
    appReady:
      document.querySelector('[data-list-id="chat-messages"]') !== null ||
      document.querySelector('nav a[href^="/channels/@me/"]') !== null ||
      document.querySelector('a[href="/channels/@me"]') !== null,
  };
}

export function observeDiscordChanges(): void {
  const key = "__ohMyDmDiscordObserverInstalled";
  const browserWindow = window as typeof window & Record<string, unknown>;
  if (browserWindow[key]) return;
  browserWindow[key] = true;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const install = () => {
    if (!document.body) return;
    new MutationObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const callback = browserWindow.__ohMyDmWake;
        if (typeof callback === "function") void callback();
      }, 120);
    }).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "href", "datetime"],
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
}
