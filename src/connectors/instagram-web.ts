import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";

import { chromium, type BrowserContext, type Page } from "playwright-core";

import { cloneBrowserProfile, isProfileLockError } from "../browser/profile.js";
import { resolveBrowserExecutable } from "../browser/resolve-browser.js";
import type {
  ChatConnector,
  ChatMessage,
  ChatSnapshot,
  Conversation,
} from "../domain.js";
import {
  normalizeConversation,
  mergeLoadedConversations,
  mergeMessageWindows,
  messageWindowsShareAnchor,
  normalizeMessage,
  normalizeSenderLabel,
  repairReplyQuoteSenders,
  restoreTransientConversationGaps,
  stabilizeButtonConversationIds,
  type RawConversation,
  type RawMessage,
} from "./instagram-dom.js";

const INBOX_URL = "https://www.instagram.com/direct/inbox/";
// Instagram localizes this element's accessible name (for example,
// "Thread list" and "대화 리스트"). Its structural role is stable across
// locales, so conversation discovery must not depend on the label text.
const THREAD_LIST_SELECTOR = 'main [role="navigation"]';
const THREAD_ROW_SELECTOR = `${THREAD_LIST_SELECTOR} [role="button"]`;

interface ConversationRowTarget {
  index: number;
  title: string;
  preview?: string;
  identity?: string;
}

// Keep this as a top-level, self-contained browser callback. Functions created
// inside evaluateAll callbacks can be rewritten by tsx/esbuild to call its
// module-scoped __name helper, which does not exist in the browser context.
export function clickInstagramConversationRow(
  elements: Element[],
  target: ConversationRowTarget,
): void {
  const rows = elements.filter((element) => {
    const rect = element.getBoundingClientRect();
    const parts = [...new Set(
      [...element.querySelectorAll("span")]
        .map((part) => part.textContent?.replaceAll("\u00a0", " ").trim())
        .filter((part): part is string => Boolean(part)),
    )];
    const text = parts.length >= 2
      ? parts.join("\n")
      : (element as HTMLElement).innerText.trim();
    return (
      text.length > 0 &&
      rect.x < 500 &&
      rect.width > 300 &&
      rect.height >= 48 &&
      rect.height <= 110
    );
  });
  const normalizedTitle = target.title.replaceAll("\u00a0", " ").trim();
  const previewLead = target.preview
    ?.replaceAll("\u00a0", " ")
    .split(" · ")[0]
    ?.trim();
  const titleMatches = rows.filter((element) => {
    const parts = [...new Set(
      [...element.querySelectorAll("span")]
        .map((part) => part.textContent?.replaceAll("\u00a0", " ").trim())
        .filter((part): part is string => Boolean(part)),
    )];
    return parts[0] === normalizedTitle;
  });
  let identityMatch: Element | undefined;
  if (target.identity) {
    for (const element of titleMatches) {
      const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
      let fiber = fiberKey
        ? (element as unknown as Record<string, {
            memoizedProps?: Record<string, unknown>;
            return?: unknown;
          }>)[fiberKey]
        : undefined;
      for (let depth = 0; fiber && depth < 12; depth += 1) {
        const props = fiber.memoizedProps;
        const threadKey = props?.threadKeyForSelection ?? props?.threadFbidForSelection;
        if (`thread:${String(threadKey)}` === target.identity) {
          identityMatch = element;
          break;
        }
        fiber = fiber.return as typeof fiber;
      }
      if (identityMatch) break;
    }
  }
  const matched = identityMatch ?? titleMatches.find((element) => {
    if (!previewLead) return true;
    const text = (element.textContent ?? "").replaceAll("\u00a0", " ");
    return text.includes(previewLead);
  }) ?? (titleMatches.length === 1 ? titleMatches[0] : undefined);
  if (!(matched instanceof HTMLElement)) throw new Error("대화 행을 찾지 못했습니다.");
  matched.click();
}

export function readInstagramMessageRows(elements: Element[]): RawMessage[] {
  const messageElements = elements.filter(
    (element) => !elements.some(
      (candidate) => candidate !== element && candidate.contains(element),
    ),
  );
  return messageElements
    .map((element) => {
      const node = element as HTMLElement;
      const rect = node.getBoundingClientRect();
      const text = node.innerText ?? "";
      const semanticLabels = [
        node.getAttribute("aria-label"),
        node.getAttribute("title"),
        ...[...node.querySelectorAll<HTMLElement>("[aria-label], [title], img[alt]")].flatMap(
          (candidate) => [
            candidate.getAttribute("aria-label"),
            candidate.getAttribute("title"),
            candidate.getAttribute("alt"),
          ],
        ),
      ]
        .map((label) => label?.replaceAll("\u00a0", " ").trim())
        .filter((label): label is string => Boolean(label));
      const detectedMediaKind = semanticLabels.some((label) =>
        /^(?:사진|이미지|photo|image|sent (?:a |an )?(?:photo|image))\.?$/i.test(label),
      )
        ? "image" as const
        : semanticLabels.some((label) =>
            /^(?:동영상|비디오|video|sent (?:a )?video)\.?$/i.test(label),
          )
          ? "video" as const
          : semanticLabels.some((label) =>
              /^(?:이모티콘|스티커|sticker|sent (?:a )?(?:sticker|emoji))\.?$/i.test(label),
            )
            ? "sticker" as const
            : undefined;
      const containers: HTMLElement[] = [];
      let container: HTMLElement | null = node;
      for (let depth = 0; depth < 10 && container; depth += 1) {
        containers.push(container);
        container = container.parentElement;
      }

      const reelLink = node.matches('a[href*="/reel/"]')
        ? node
        : node.closest<HTMLElement>('a[href*="/reel/"]') ??
          node.querySelector<HTMLElement>('a[href*="/reel/"]');
      let inlineShare = false;
      let sharedTargetUrl = "";
      const fiberContainers = [
        node,
        ...node.querySelectorAll<HTMLElement>("*"),
      ].slice(0, 100);
      for (const candidateContainer of fiberContainers) {
        const fiberKey = Object.keys(candidateContainer).find((key) =>
          key.startsWith("__reactFiber$") || key.startsWith("__reactProps$"),
        );
        if (!fiberKey) continue;
        const root = (candidateContainer as unknown as Record<string, unknown>)[fiberKey];
        const fiberQueue: Array<{ value: unknown; depth: number }> = [
          { value: root, depth: 0 },
        ];
        const visitedFibers = new WeakSet<object>();
        for (let fiberIndex = 0; fiberIndex < fiberQueue.length && fiberIndex < 60; fiberIndex += 1) {
          const fiberEntry = fiberQueue[fiberIndex]!;
          const fiberValue = fiberEntry.value;
          if (!fiberValue || typeof fiberValue !== "object" || visitedFibers.has(fiberValue)) continue;
          visitedFibers.add(fiberValue);
          const fiber = fiberValue as Record<string, unknown>;
          const propsQueue: Array<{ value: unknown; depth: number }> = [
            { value: fiber.memoizedProps, depth: 0 },
            { value: fiber.pendingProps, depth: 0 },
          ];
          const visitedProps = new WeakSet<object>();
          for (let propIndex = 0; propIndex < propsQueue.length && propIndex < 120; propIndex += 1) {
            const entry = propsQueue[propIndex]!;
            if (!entry.value || typeof entry.value !== "object" || visitedProps.has(entry.value)) continue;
            try {
              if (entry.value instanceof Node || entry.value instanceof Window) continue;
            } catch {
              continue;
            }
            visitedProps.add(entry.value);
            const record = entry.value as Record<string, unknown>;
            try {
              if (record.content_type === "MESSAGE_INLINE_SHARE") inlineShare = true;
              if (typeof record.targetUrl === "string") sharedTargetUrl = record.targetUrl;
            } catch {
              continue;
            }
            if (entry.depth >= 4) continue;
            try {
              for (const value of Object.values(record)) {
                if (
                  value &&
                  typeof value === "object" &&
                  !(value instanceof Node) &&
                  !(value instanceof Window)
                ) {
                  propsQueue.push({ value, depth: entry.depth + 1 });
                }
              }
            } catch {
              continue;
            }
          }
          if (fiberEntry.depth < 5 && fiber.child) {
            fiberQueue.push({ value: fiber.child, depth: fiberEntry.depth + 1 });
          }
          // The root fiber's sibling belongs to the next DOM message. Only
          // inspect siblings below the current card's own child tree.
          if (fiberEntry.depth > 0 && fiber.sibling) {
            fiberQueue.push({ value: fiber.sibling, depth: fiberEntry.depth });
          }
          if (inlineShare && sharedTargetUrl) break;
        }
        if (inlineShare && sharedTargetUrl) break;
      }
      const isReel = Boolean(
        reelLink ||
        (inlineShare && (
          /instagram\.com\/reel\//i.test(sharedTargetUrl) ||
          /instagram\.com\/p\//i.test(sharedTargetUrl) &&
            /(?:carousel_share_child_media_id|is_ineligible_for_clips_chaining=false)/i.test(sharedTargetUrl)
        )),
      );
      const isPost = Boolean(
        inlineShare && !isReel && /instagram\.com\/p\//i.test(sharedTargetUrl),
      );
      const reelTitle = isReel && reelLink
        ? [
            reelLink.getAttribute("aria-label"),
            reelLink.getAttribute("title"),
          ]
            .map((candidate) => candidate?.replaceAll("\u00a0", " ").trim())
            .find((candidate): candidate is string => Boolean(
              candidate &&
              candidate.length <= 240 &&
              !/^[a-z0-9._]+$/i.test(candidate) &&
              !/^(?:릴스|reel|reels|watch reel|original audio)$/i.test(candidate) &&
              !/(?:님의 릴스|(?:'s|’s) reel|reel by .+)$/i.test(candidate),
            ))
        : undefined;
      const displayText = isReel
        ? reelTitle
          ? `${reelTitle.replace(/\s*\(릴스\)$/, "")}(릴스)`
          : "(릴스)"
        : isPost
          ? "(게시물)"
          : detectedMediaKind === "image"
            ? "사진을 보냈습니다."
            : detectedMediaKind === "video"
              ? "동영상을 보냈습니다."
              : detectedMediaKind === "sticker"
                ? "이모티콘을 보냈습니다."
        : text;
      const ownLabel = element.getAttribute("aria-label");
      let sender: string | null = null;
      let senderSource: "display" | "profile" | undefined;
      let senderIdentity: string | null = null;

      // Reply rows often render the quoted message owner's display name in
      // the card while the row aria-label identifies the actual sender. The
      // aria-label must win here or replies are attributed to their target.
      if (
        ownLabel &&
        (/^.+? replied to .+$/i.test(ownLabel) ||
          /^.+?님이 (?:회원님|.+?님)에게 (?:보낸 답장|답장했습니다)$/.test(ownLabel))
      ) {
        sender = ownLabel;
        senderSource = "display";
      }

      // Instagram can expose the account ID in an avatar label while showing
      // the user's chosen display name above the same message group. Search
      // every visible ancestor first so one person is not rendered under two
      // names within a consecutive group.
      for (const candidateContainer of sender ? [] : containers) {
        const nestedMessageRows = candidateContainer.querySelectorAll(
          '[role="row"], [role="listitem"]',
        ).length;
        if (candidateContainer !== node && nestedMessageRows > 1) continue;
        const lines = [...new Set(
          candidateContainer.innerText
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
        )];
        if (
          lines.length >= (detectedMediaKind ? 1 : 2) &&
          lines[0] !== text.trim() &&
          lines[0]!.length <= 80 &&
          !/^(?:new messages?|unread messages?|새(?:로운)? 메시지|읽지 않은 메시지)$/i.test(lines[0]!) &&
          !/^(?:(?:(?:19|20)\d{2}\.\s*)?\d{1,2}\.\s*\d{1,2}\.\s*|\([월화수목금토일]\)\s*|(?:오늘|어제)\s*)?(?:오전|오후)\s*\d{1,2}:\d{2}$/.test(lines[0]!) &&
          !/^(?:(?:today|yesterday)(?:\s+at)?\s+|(?:(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?),?\s+)?\d{1,2}:\d{2}\s*(?:am|pm)$/i.test(lines[0]!)
        ) {
          sender = lines[0]!;
          senderSource = "display";
          break;
        }
      }

      // Keep the stable profile/account label even when a human-friendly
      // display name was found. The connector uses this pair to canonicalize
      // later rows that expose only the account ID.
      if (!ownLabel || !(/replied to/i.test(ownLabel) || /답장/.test(ownLabel))) {
        let fallbackIdentity: string | null = null;
        for (const candidateContainer of containers) {
          // The avatar label and its profile link are not always the same DOM
          // node (or even direct ancestors). Prefer the stable /username/
          // route anywhere in the smallest message-group container. Do not
          // use broad links for inline shares: those belong to the shared
          // reel/post author, not necessarily the DM sender.
          if (!inlineShare) {
            const profileIds = [
              ...(candidateContainer.matches("a[href]") ? [candidateContainer] : []),
              ...candidateContainer.querySelectorAll<HTMLElement>("a[href]"),
            ].map((candidate) => candidate.getAttribute("href"))
              .map((href) => href?.match(/^\/([^/?#]+)\/?(?:\?.*)?$/)?.[1])
              .filter((profileId): profileId is string => Boolean(
                profileId &&
                !/^(?:direct|reel|reels|p|stories|explore|accounts)$/i.test(profileId),
              ));
            const uniqueProfileIds = [...new Set(profileIds)];
            if (uniqueProfileIds.length === 1) {
              senderIdentity = uniqueProfileIds[0]!;
              break;
            }
          }

          const profileElements = [
            ...candidateContainer.querySelectorAll<HTMLElement>('img[alt], [aria-label], [title]'),
          ].filter((candidate) => {
            const label = [
              candidate.getAttribute("alt"),
              candidate.getAttribute("aria-label"),
              candidate.getAttribute("title"),
            ].filter(Boolean).join(" ");
            return label.length <= 360 &&
              /프로필 사진|profile picture|프로필 페이지|open the profile page of/i.test(label);
          });
          const identities = profileElements.flatMap((candidate) => {
            const href = candidate.closest<HTMLAnchorElement>('a[href]')?.getAttribute("href");
            const profileId = href?.match(/^\/([^/?#]+)\/?(?:\?.*)?$/)?.[1];
            if (profileId && !/^(?:direct|reel|reels|p|stories|explore|accounts)$/i.test(profileId)) {
              return [profileId];
            }
            return [
              candidate.getAttribute("alt"),
              candidate.getAttribute("aria-label"),
              candidate.getAttribute("title"),
            ].filter((label): label is string => Boolean(label));
          });
          const uniqueIdentities = [...new Set(identities)];
          if (!fallbackIdentity && uniqueIdentities.length === 1) {
            fallbackIdentity = uniqueIdentities[0]!;
          }
        }
        senderIdentity ??= fallbackIdentity;
      }

      if (!sender && senderIdentity) {
        sender = senderIdentity;
        senderSource = "profile";
      }

      if (!sender) {
        for (const candidateContainer of containers) {
          const nestedMessageRows = candidateContainer.querySelectorAll(
            '[role="row"], [role="listitem"]',
          ).length;
          if (candidateContainer !== node && nestedMessageRows > 1) continue;
          const labels = [
            ...candidateContainer.querySelectorAll<HTMLElement>('img[alt], [aria-label], [title]'),
          ].flatMap((candidate) => [
            candidate.getAttribute("alt"),
            candidate.getAttribute("aria-label"),
            candidate.getAttribute("title"),
          ]);
          sender = labels.find((label): label is string =>
            Boolean(
              label &&
              label !== ownLabel &&
              label.length <= 120 &&
              (/프로필 사진|profile picture|보낸 메시지|프로필 페이지|open the profile page of/i.test(label)),
            ),
          ) ?? null;
          if (sender) {
            senderSource = "profile";
            break;
          }
        }
      }

      return {
        text: displayText,
        sender,
        ariaLabel: ownLabel,
        timestamp: element.querySelector("time")?.getAttribute("datetime"),
        ...(isReel ? { kind: "reel" as const } : {}),
        ...(isPost ? { kind: "post" as const } : {}),
        ...(!isReel && !isPost && detectedMediaKind ? { kind: detectedMediaKind } : {}),
        ...(senderSource ? { senderSource } : {}),
        ...(senderIdentity ? { senderIdentity } : {}),
        visualTop: rect.top,
        visualBottom: rect.bottom,
        visualLeft: rect.left,
      };
    })
    .filter((item) => item.text.trim().length > 0);
}

export interface InstagramWebOptions {
  profileDir: string;
  headless?: boolean;
  cloneProfileWhenLocked?: boolean;
}

export function isInstagramProfileLockError(error: unknown): boolean {
  return isProfileLockError(error);
}

export async function cloneInstagramProfile(
  sourceProfileDir: string,
  temporaryRoot?: string,
): Promise<{ profileDir: string; cleanupDir: string }> {
  return cloneBrowserProfile(sourceProfileDir, temporaryRoot, "oh-my-dm-instagram-");
}

export interface InstagramDirectThreadIdentity {
  displayName: string;
  username: string;
}

// A direct-message header links the participant's display name and username
// to their profile. Group headers are buttons rather than profile links, so
// requiring this exact visible structure prevents a room title from becoming
// a sender name.
export function readInstagramDirectThreadIdentity(
  main: Element,
): InstagramDirectThreadIdentity | null {
  const profileLinks = [...main.querySelectorAll<HTMLAnchorElement>('a[href]')]
    .filter((link) => {
      const rect = link.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.top >= 0 &&
        rect.bottom <= 100 &&
        /^\/[^/?#]+\/?(?:\?.*)?$/.test(link.getAttribute("href") ?? "") &&
        Boolean(link.querySelector("h2"))
      );
    });
  if (profileLinks.length !== 1) return null;

  const link = profileLinks[0]!;
  const username = link.getAttribute("href")?.match(/^\/([^/?#]+)/)?.[1]?.trim();
  const headerName = link.querySelector("h2")?.textContent
    ?.replaceAll("\u00a0", " ")
    .trim();
  if (!username || !headerName) return null;

  const displayName = headerName.replace(/님$/, "").trim();
  if (!displayName || displayName === username) return null;
  return { displayName, username };
}

export function canonicalizeInstagramSenders(
  rawMessages: RawMessage[],
  aliases: Map<string, string>,
): RawMessage[] {
  // Instagram's current group-chat DOM puts the visible display name above
  // the first bubble in a sender run, but puts the avatar/profile link beside
  // the last bubble. They are therefore often exposed on adjacent RawMessage
  // objects rather than on the same object.
  let currentDisplayName: string | undefined;
  for (const raw of rawMessages) {
    const sender = normalizeSenderLabel(raw.sender);
    const isReply = Boolean(
      raw.ariaLabel && (/replied to/i.test(raw.ariaLabel) || /답장/.test(raw.ariaLabel)),
    );
    if (sender === "나") {
      currentDisplayName = undefined;
      continue;
    }
    if (raw.senderSource === "display" && sender && !isReply) {
      currentDisplayName = sender;
    }

    const identity = normalizeSenderLabel(raw.senderIdentity) ??
      (raw.senderSource === "profile" ? sender : undefined);
    if (
      currentDisplayName &&
      identity &&
      currentDisplayName !== identity &&
      currentDisplayName !== "나"
    ) {
      aliases.set(identity, currentDisplayName);
    }
  }

  return rawMessages.map((raw) => {
    const identity = normalizeSenderLabel(raw.sender);
    const stableIdentity = normalizeSenderLabel(raw.senderIdentity);
    const displayName = stableIdentity
      ? aliases.get(stableIdentity)
      : identity
        ? aliases.get(identity)
        : undefined;
    return displayName ? { ...raw, sender: displayName, senderSource: "display" } : raw;
  });
}

export function inheritInstagramRawSenders(rawMessages: RawMessage[]): RawMessage[] {
  const resolved = rawMessages.map((raw) => ({ ...raw }));
  for (let index = resolved.length - 2; index >= 0; index -= 1) {
    const current = resolved[index]!;
    const next = resolved[index + 1]!;
    const currentSender = normalizeSenderLabel(current.sender);
    const nextSender = normalizeSenderLabel(next.sender);
    if (
      (!currentSender || currentSender === "unknown") &&
      nextSender &&
      nextSender !== "unknown" &&
      nextSender !== "나" &&
      isSameVisualSenderRun(current, next)
    ) {
      current.sender = nextSender;
      current.senderSource = next.senderSource;
      current.senderIdentity = next.senderIdentity;
      current.senderInferred = true;
    }
  }

  let lastExternalSender: string | undefined;
  return resolved.map((raw) => {
    const normalizedSender = normalizeSenderLabel(raw.sender);
    if (normalizedSender === "나") {
      lastExternalSender = undefined;
      return raw;
    }
    if (raw.kind === "reel" && raw.senderSource === "profile" && lastExternalSender) {
      return { ...raw, sender: lastExternalSender, senderInferred: true };
    }
    if (normalizedSender && normalizedSender !== "unknown") {
      // Keep the full reply label on this row so normalizeMessage can create
      // replyTo metadata, but only carry the actual sender name into following
      // unlabeled bubbles. Otherwise one reply turns the rest of the sender
      // run into replies as well.
      lastExternalSender = normalizedSender;
      return raw;
    }
    return lastExternalSender
      ? { ...raw, sender: lastExternalSender, senderInferred: true }
      : raw;
  });
}

function isSameVisualSenderRun(current: RawMessage, next: RawMessage): boolean {
  if (
    current.visualBottom === undefined ||
    current.visualLeft === undefined ||
    next.visualTop === undefined ||
    next.visualLeft === undefined
  ) {
    return false;
  }
  const verticalGap = next.visualTop - current.visualBottom;
  return verticalGap >= -2 && verticalGap <= 12 &&
    Math.abs(next.visualLeft - current.visualLeft) <= 8;
}

export class InstagramWebConnector extends EventEmitter implements ChatConnector {
  private context?: BrowserContext;
  private page?: Page;
  private refreshTimer?: NodeJS.Timeout;
  private refreshRunning = false;
  private refreshAgain = false;
  private lastFingerprint = "";
  private browserLabel = "Chromium";
  private activeConversationOverride?: string;
  private loadingOlder = false;
  private readingOlderWindow = false;
  private preserveLoadedConversations = false;
  private stopped = false;
  private desiredRunning = false;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private temporaryProfileDir?: string;
  private readonly messageHistory = new Map<string, ChatMessage[]>();
  private readonly senderAliases = new Map<string, Map<string, string>>();
  private snapshot: ChatSnapshot = {
    state: "starting",
    conversations: [],
    messages: [],
    detail: "브라우저 엔진을 시작하는 중",
  };

  public constructor(private readonly options: InstagramWebOptions) {
    super();
  }

  public getSnapshot(): ChatSnapshot {
    return this.snapshot;
  }

  public async refresh(): Promise<void> {
    await this.requireReadyPage();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    await this.performRefresh();
  }

  public async loadOlderMessages(): Promise<number> {
    const page = await this.requireReadyPage();
    const threadId = page.url().match(/\/direct\/t\/([^/?#]+)/)?.[1];
    if (!threadId) return 0;

    while (this.refreshRunning) await page.waitForTimeout(50);
    const previousCount = this.messageHistory.get(threadId)?.length ?? this.snapshot.messages.length;
    // Freeze passive refreshes before taking the anchor snapshot. Otherwise a
    // DOM event can race between the snapshot and the scroll itself.
    this.loadingOlder = true;
    try {
      const beforeWindow = await this.readVisibleMessages(page, threadId);
      if (beforeWindow.length === 0) return 0;
      const scrollFromCurrent = async (fraction: number) =>
        page.locator("main").evaluate((main, scrollFraction): {
          moved: boolean;
          previousScrollTop: number;
        } => {
          const candidates = [...main.querySelectorAll<HTMLElement>("div")]
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return (
                rect.width > 280 &&
                rect.height > 180 &&
                rect.left > window.innerWidth * 0.3 &&
                element.scrollHeight > element.clientHeight + 30 &&
                /(auto|scroll)/.test(style.overflowY)
              );
            })
            .sort((left, right) => left.clientWidth * left.clientHeight - right.clientWidth * right.clientHeight);
          const scroller = candidates[0];
          if (!scroller) return { moved: false, previousScrollTop: 0 };
          const before = scroller.scrollTop;
          const amount = Math.max(40, Math.floor(scroller.clientHeight * scrollFraction));
          scroller.scrollBy({ top: -amount, behavior: "instant" });
          if (scroller.scrollTop === before && before === 0) scroller.scrollTop = -amount;
          return { moved: scroller.scrollTop !== before, previousScrollTop: before };
        }, fraction).catch(() => ({ moved: false, previousScrollTop: 0 }));
      const restoreScroll = async (previousScrollTop: number) => {
        await page.locator("main").evaluate((main, targetScrollTop) => {
          const candidates = [...main.querySelectorAll<HTMLElement>("div")]
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return (
                rect.width > 280 &&
                rect.height > 180 &&
                rect.left > window.innerWidth * 0.3 &&
                element.scrollHeight > element.clientHeight + 30 &&
                /(auto|scroll)/.test(style.overflowY)
              );
            })
            .sort((left, right) => left.clientWidth * left.clientHeight - right.clientWidth * right.clientHeight);
          const scroller = candidates[0];
          if (scroller) scroller.scrollTop = targetScrollTop;
        }, previousScrollTop).catch(() => undefined);
      };

      let afterWindow: ChatMessage[] = [];
      let foundContinuousWindow = false;
      for (const fraction of [0.3, 0.15, 0.08]) {
        const scrollResult = await scrollFromCurrent(fraction);
        if (!scrollResult.moved) return 0;
        await page.waitForTimeout(450);
        afterWindow = await this.readVisibleMessages(page, threadId);
        if (afterWindow.length > 0 && messageWindowsShareAnchor(beforeWindow, afterWindow)) {
          foundContinuousWindow = true;
          break;
        }
        // Never accept a discontinuous page. Restore the known window and try
        // a smaller overlapping movement instead of skipping the gap.
        await restoreScroll(scrollResult.previousScrollTop);
        await page.waitForTimeout(120);
      }
      if (!foundContinuousWindow) return 0;

      this.readingOlderWindow = true;
      const merged = mergeMessageWindows(
        this.messageHistory.get(threadId) ?? this.snapshot.messages,
        afterWindow,
        "older",
      ).slice(0, 500);
      this.messageHistory.set(threadId, merged);
      this.updateSnapshot({ ...this.snapshot, messages: merged });
      return Math.max(0, merged.length - previousCount);
    } finally {
      this.loadingOlder = false;
    }
  }

  public async loadMoreConversations(): Promise<number> {
    const page = await this.requireReadyPage();
    while (this.refreshRunning) await page.waitForTimeout(50);
    const previousCount = this.snapshot.conversations.length;
    // Scrolling virtualizes the top rows and emits DOM wake events before this
    // method's explicit refresh. Preserve the captured order from that first
    // event onward, otherwise temporarily missing rows can be discarded.
    this.preserveLoadedConversations = true;
    const moved = await page.locator(THREAD_LIST_SELECTOR).evaluate((threadList): boolean => {
      const candidates = [threadList, ...threadList.querySelectorAll<HTMLElement>("div")]
        .filter((element): element is HTMLElement => element instanceof HTMLElement)
        .filter((element) => {
          const style = getComputedStyle(element);
          return (
            element.clientHeight > 120 &&
            element.scrollHeight > element.clientHeight + 20 &&
            /(auto|scroll)/.test(style.overflowY)
          );
        })
        .sort((left, right) => left.clientWidth * left.clientHeight - right.clientWidth * right.clientHeight);
      const scroller = candidates[0];
      if (!scroller) return false;
      const before = scroller.scrollTop;
      scroller.scrollBy({
        top: Math.max(300, Math.floor(scroller.clientHeight * 0.8)),
        behavior: "instant",
      });
      return scroller.scrollTop !== before;
    }).catch(() => false);
    if (!moved) return 0;

    await page.waitForTimeout(450);
    await this.performRefresh();
    return Math.max(0, this.snapshot.conversations.length - previousCount);
  }

  public start(): Promise<void> {
    this.desiredRunning = true;
    this.stopped = false;
    return this.enqueueLifecycle(async () => {
      if (!this.desiredRunning) return;
      if (this.getUsablePage()) return;
      if (this.context) {
        await this.context.close().catch(() => undefined);
        this.context = undefined;
        this.page = undefined;
        await this.removeTemporaryProfile();
      }
      await this.startBrowser();
    });
  }

  private async startBrowser(): Promise<void> {
    await fs.mkdir(this.options.profileDir, { recursive: true, mode: 0o700 });
    const headless = this.options.headless ?? true;
    const browser = resolveBrowserExecutable();
    this.browserLabel = `${browser.label}${headless ? " Headless" : ""}`;
    const launch = (profileDir: string) => chromium.launchPersistentContext(profileDir, {
        executablePath: browser.executablePath,
        headless,
        viewport: { width: 1100, height: 780 },
      });
    let runtimeProfileDir = this.options.profileDir;
    try {
      if (
        this.options.cloneProfileWhenLocked &&
        await fs.lstat(path.join(this.options.profileDir, "SingletonLock"))
          .then(() => true)
          .catch(() => false)
      ) {
        const clone = await cloneInstagramProfile(this.options.profileDir);
        runtimeProfileDir = clone.profileDir;
        this.temporaryProfileDir = clone.cleanupDir;
        this.browserLabel = `${this.browserLabel} · shared session`;
      }
      try {
        this.context = await launch(runtimeProfileDir);
      } catch (error) {
        if (
          !this.options.cloneProfileWhenLocked ||
          runtimeProfileDir !== this.options.profileDir ||
          !isInstagramProfileLockError(error)
        ) throw error;
        const clone = await cloneInstagramProfile(this.options.profileDir);
        runtimeProfileDir = clone.profileDir;
        this.temporaryProfileDir = clone.cleanupDir;
        this.browserLabel = `${this.browserLabel} · shared session`;
        this.context = await launch(runtimeProfileDir);
      }
    } catch (error) {
      await this.removeTemporaryProfile();
      const detail = error instanceof Error ? error.message : String(error);
      this.updateSnapshot({ ...this.snapshot, state: "error", detail });
      throw error;
    }
    if (this.stopped) {
      await this.context.close();
      this.context = undefined;
      await this.removeTemporaryProfile();
      return;
    }

    try {
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
      await this.installWakeSignals(this.page);
      await this.page.goto(INBOX_URL, { waitUntil: "domcontentloaded" });
      this.scheduleRefresh("startup", 0);
    } catch (error) {
      await this.context.close().catch(() => undefined);
      this.context = undefined;
      this.page = undefined;
      await this.removeTemporaryProfile();
      const detail = error instanceof Error ? error.message : String(error);
      this.updateSnapshot({ ...this.snapshot, state: "error", detail });
      throw error;
    }
  }

  public stop(): Promise<void> {
    this.desiredRunning = false;
    this.stopped = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    return this.enqueueLifecycle(async () => {
      // React can immediately mount the same connector again after an effect
      // cleanup. In that case the newest intent wins and the live browser must
      // not be torn down underneath an already populated conversation list.
      if (this.desiredRunning) return;
      await this.context?.close();
      this.context = undefined;
      this.page = undefined;
      await this.removeTemporaryProfile();
    });
  }

  private enqueueLifecycle(task: () => Promise<void>): Promise<void> {
    const pending = this.lifecycleQueue.then(task, task);
    this.lifecycleQueue = pending.catch(() => undefined);
    return pending;
  }

  private async removeTemporaryProfile(): Promise<void> {
    const temporaryProfileDir = this.temporaryProfileDir;
    this.temporaryProfileDir = undefined;
    if (temporaryProfileDir) {
      await fs.rm(temporaryProfileDir, { recursive: true, force: true });
    }
  }

  public async openConversation(id: string): Promise<void> {
    const page = await this.requireReadyPage();
    const conversation = this.snapshot.conversations.find((item) => item.id === id);
    if (!conversation) throw new Error(`대화를 찾을 수 없습니다: ${id}`);
    const previousOverride = this.activeConversationOverride;
    const previousUrl = page.url();
    this.readingOlderWindow = false;

    // Pin the target before clicking. Instagram emits DOM wake events during
    // navigation, and a refresh triggered in that window must never reuse the
    // previously opened conversation id.
    this.activeConversationOverride = id;

    if (conversation.href.startsWith("button:")) {
      const stableThreadId = conversation.identity?.match(/^thread:(\d+)$/)?.[1];
      if (stableThreadId) {
        try {
          await page.goto(`https://www.instagram.com/direct/t/${stableThreadId}/`, {
            waitUntil: "domcontentloaded",
          });
          // A hard route reaches the correct thread immediately, but Instagram
          // hydrates its message DOM later. Do not publish an empty/stale
          // snapshot during that gap.
          for (let attempt = 0; attempt < 15; attempt += 1) {
            if ((await this.readVisibleMessages(page, stableThreadId)).length > 0) break;
            await page.waitForTimeout(200);
          }
          await this.refreshAfterConversationOpen(page);
        } catch (error) {
          this.activeConversationOverride = previousOverride;
          throw error;
        }
        return;
      }
      const index = Number(conversation.href.slice("button:".length));
      try {
        await page.locator(THREAD_ROW_SELECTOR).evaluateAll(clickInstagramConversationRow, {
          index,
          title: conversation.title,
          preview: conversation.preview,
          identity: conversation.identity,
        });
      } catch (error) {
        this.activeConversationOverride = previousOverride;
        throw error;
      }
      if (previousOverride !== id && page.url() === previousUrl) {
        await page.waitForURL(
          (url) => /\/direct\/t\//.test(url.pathname) && url.href !== previousUrl,
          { timeout: 5_000 },
        ).catch(() => undefined);
      }
      await this.refreshAfterConversationOpen(page);
      return;
    }

    try {
      await page.goto(new URL(conversation.href, "https://www.instagram.com").href, {
        waitUntil: "domcontentloaded",
      });
      await this.refreshAfterConversationOpen(page);
    } catch (error) {
      this.activeConversationOverride = previousOverride;
      throw error;
    }
  }

  private async refreshAfterConversationOpen(page: Page): Promise<void> {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    while (this.refreshRunning) await page.waitForTimeout(25);
    await this.performRefresh();
  }

  public async sendMessage(text: string): Promise<void> {
    const page = await this.requireReadyPage();
    const message = text.trim();
    if (!message) return;
    this.readingOlderWindow = false;

    const editor = page.locator('[contenteditable="true"][role="textbox"]').last();
    await editor.waitFor({ state: "visible", timeout: 5_000 });
    const previousLastMessageId = this.snapshot.messages.at(-1)?.id;
    await editor.fill(message);
    await editor.press("Enter");
    const confirmed = await this.confirmSentMessage(page, message, previousLastMessageId);
    if (!confirmed) this.scheduleRefresh("sent-message-fallback", 0);
  }

  private async confirmSentMessage(
    page: Page,
    sentText: string,
    previousLastMessageId?: string,
  ): Promise<boolean> {
    const threadId = page.url().match(/\/direct\/t\/([^/?#]+)/)?.[1];
    if (!threadId) return false;

    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (attempt > 0) await page.waitForTimeout(50);
      const visibleMessages = await this.readVisibleMessages(page, threadId);
      const lastMessage = visibleMessages.at(-1);
      if (
        lastMessage &&
        normalizeComparableText(lastMessage.text) === normalizeComparableText(sentText) &&
        lastMessage.id !== previousLastMessageId
      ) {
        const messages = mergeMessageWindows(
          this.messageHistory.get(threadId) ?? [],
          visibleMessages,
          "newer",
        ).slice(-500);
        this.messageHistory.set(threadId, messages);
        this.updateSnapshot({
          ...this.snapshot,
          state: "connected",
          activeConversationId: this.activeConversationOverride ?? threadId,
          messages,
        });
        return true;
      }
    }
    return false;
  }

  private requirePage(): Page {
    const page = this.getUsablePage();
    if (!page) {
      throw new Error("Instagram 커넥터가 시작되지 않았습니다.");
    }
    return page;
  }

  private async requireReadyPage(): Promise<Page> {
    const page = this.getUsablePage();
    if (page) return page;
    await this.start();
    return this.requirePage();
  }

  private getUsablePage(): Page | undefined {
    const page = this.page;
    if (!page) return undefined;
    const isClosed = (page as Page & { isClosed?: () => boolean }).isClosed;
    return typeof isClosed !== "function" || !isClosed.call(page) ? page : undefined;
  }

  private async installWakeSignals(page: Page): Promise<void> {
    await page.exposeBinding("__ohMyDmWake", () => {
      this.scheduleRefresh("dom");
    });

    page.on("websocket", (socket) => {
      socket.on("framereceived", () => this.scheduleRefresh("websocket"));
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.scheduleRefresh("navigation", 120);
    });
    page.on("close", () => this.setDisconnected("브라우저 탭이 닫혔습니다."));

    await page.addInitScript(observeInstagramChanges);
    await page.evaluate(observeInstagramChanges).catch(() => undefined);
  }

  private scheduleRefresh(_reason: string, delay = 180): void {
    if (this.stopped) return;
    if (this.loadingOlder) return;
    // A busy MQTT/WebSocket connection must not keep pushing the refresh
    // forever into the future. Coalesce bursts into one bounded refresh.
    if (this.refreshTimer) {
      if (delay !== 0) return;
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.performRefresh();
    }, delay);
  }

  private async performRefresh(): Promise<void> {
    if (this.stopped) return;
    if (this.refreshRunning) {
      this.refreshAgain = true;
      return;
    }

    this.refreshRunning = true;
    try {
      const page = this.requirePage();
      const url = page.url();
      const sessionCookies = await this.context?.cookies("https://www.instagram.com") ?? [];
      const hasSession = sessionCookies.some(
        (cookie) => cookie.name === "sessionid" && cookie.value.length > 0,
      );
      const loginRequired = !hasSession || /\/accounts\/login|\/challenge\//.test(url);

      if (loginRequired) {
        this.updateSnapshot({
          ...this.snapshot,
          state: "login-required",
          detail: "Playwright Chromium에서 Instagram 로그인을 완료하세요: oh-my-dm login instagram",
        });
        return;
      }

      const rawConversations = await page.locator('a[href*="/direct/t/"]').evaluateAll(
        (elements): RawConversation[] =>
          elements.map((element) => ({
            href: (element as HTMLAnchorElement).getAttribute("href") ?? "",
            text: (element as HTMLElement).innerText ?? "",
            ariaLabel: element.getAttribute("aria-label"),
          })),
      );

      const linkConversations = dedupeConversations(
        rawConversations
          .map(normalizeConversation)
          .filter((item): item is Conversation => item !== undefined),
      );
      const rawButtonConversations = await page
          .locator(THREAD_ROW_SELECTOR)
          .evaluateAll((elements): RawConversation[] => {
            const rows = elements.filter((element) => {
              const rect = element.getBoundingClientRect();
              const parts = [...new Set(
                [...element.querySelectorAll("span")]
                  .map((part) => part.textContent?.replaceAll("\u00a0", " ").trim())
                  .filter((part): part is string => Boolean(part)),
              )];
              const text = parts.length >= 2
                ? parts.join("\n")
                : (element as HTMLElement).innerText.trim();
              return (
                text.length > 0 &&
                rect.x < 500 &&
                rect.width > 300 &&
                rect.height >= 48 &&
                rect.height <= 110
              );
            });
            return rows.map((element, index) => {
              const parts = [...new Set(
                [...element.querySelectorAll("span")]
                  .map((part) => part.textContent?.replaceAll("\u00a0", " ").trim())
                  .filter((part): part is string => Boolean(part)),
              )];
              return {
                href: `button:${index}`,
                text: parts.length >= 2
                  ? parts.join("\n")
                  : (element as HTMLElement).innerText.trim(),
                ariaLabel: element.getAttribute("aria-label"),
                identity: (() => {
                  const fiberKey = Object.keys(element).find((key) =>
                    key.startsWith("__reactFiber$"),
                  );
                  let fiber = fiberKey
                    ? (element as unknown as Record<string, {
                        memoizedProps?: Record<string, unknown>;
                        return?: unknown;
                      }>)[fiberKey]
                    : undefined;
                  for (let depth = 0; fiber && depth < 12; depth += 1) {
                    const props = fiber.memoizedProps;
                    const threadKey =
                      props?.threadKeyForSelection ?? props?.threadFbidForSelection;
                    if (typeof threadKey === "string" || typeof threadKey === "number") {
                      return `thread:${threadKey}`;
                    }
                    fiber = fiber.return as typeof fiber;
                  }
                  return undefined;
                })(),
              };
            });
          });
      const buttonConversations = stabilizeButtonConversationIds(
        rawButtonConversations
          .map(normalizeConversation)
          .filter((item): item is Conversation => item !== undefined),
        this.snapshot.conversations,
      );
      // The current Instagram layout exposes complete rows as buttons while
      // anchors can be partial (notably omitting the active thread).
      const capturedConversations = buttonConversations.length > 0
        ? buttonConversations
        : linkConversations;
      const conversations = this.preserveLoadedConversations
        ? mergeLoadedConversations(this.snapshot.conversations, capturedConversations)
        : restoreTransientConversationGaps(this.snapshot.conversations, capturedConversations);

      const routeConversationId = url.match(/\/direct\/t\/([^/?#]+)/)?.[1];
      const activeConversationId = routeConversationId
        ? this.activeConversationOverride ?? routeConversationId
        : undefined;
      const visibleMessages = activeConversationId
        ? await this.readVisibleMessages(page, routeConversationId ?? activeConversationId)
        : [];
      const messageThreadId = routeConversationId ?? activeConversationId;
      const existingMessages = messageThreadId
        ? this.messageHistory.get(messageThreadId) ?? []
        : [];
      // Once Chromium has scrolled into history, observer/WebSocket refreshes
      // keep seeing a virtualized historical fragment. Ignore those passive
      // reads; only an explicit loadOlder call is allowed to extend history.
      const mergedMessages = messageThreadId && this.readingOlderWindow && !this.loadingOlder
        ? existingMessages
        : messageThreadId
          ? mergeMessageWindows(
              existingMessages,
              visibleMessages,
              this.loadingOlder ? "older" : "newer",
            )
          : [];
      const messages = this.loadingOlder
        ? mergedMessages.slice(0, 500)
        : mergedMessages.slice(-500);
      if (messageThreadId) this.messageHistory.set(messageThreadId, messages);

      this.updateSnapshot({
        state: "connected",
        conversations,
        activeConversationId,
        messages,
        detail: conversations.length
          ? `${this.browserLabel} · DOM + WebSocket 이벤트 감지 중`
          : `${this.browserLabel} · 대화 목록을 기다리는 중`,
      });
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (isTransientInstagramNavigationError(normalized)) {
        // Instagram replaces the document while switching routes. A DOM read
        // caught in that small window is expected; retry against the new page
        // instead of surfacing a connector failure in the TUI.
        this.scheduleRefresh("navigation-retry", 250);
        return;
      }
      this.emit("error", normalized);
      this.updateSnapshot({ ...this.snapshot, state: "error", detail: normalized.message });
    } finally {
      this.refreshRunning = false;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        this.scheduleRefresh("coalesced", 0);
      }
    }
  }

  private async readVisibleMessages(page: Page, threadId: string): Promise<ChatMessage[]> {
    const directThreadIdentity = await page
      .locator("main")
      .evaluate(readInstagramDirectThreadIdentity)
      .catch(() => null);
    let rawMessages = await page
      .locator('main [role="row"], main [role="listitem"]')
      .evaluateAll(readInstagramMessageRows);

    if (rawMessages.length === 0) {
      rawMessages = await page.locator("main div").evaluateAll((elements): RawMessage[] => {
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        return elements.flatMap((element): RawMessage[] => {
            const node = element as HTMLElement;
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            const text = node.innerText.trim();
            const semanticLabels = [
              node.getAttribute("aria-label"),
              node.getAttribute("title"),
              ...[...node.querySelectorAll<HTMLElement>("[aria-label], [title], img[alt]")].flatMap(
                (candidate) => [
                  candidate.getAttribute("aria-label"),
                  candidate.getAttribute("title"),
                  candidate.getAttribute("alt"),
                ],
              ),
            ]
              .map((label) => label?.replaceAll("\u00a0", " ").trim())
              .filter((label): label is string => Boolean(label));
            const detectedMediaKind = semanticLabels.some((label) =>
              /^(?:사진|이미지|photo|image|sent (?:a |an )?(?:photo|image))\.?$/i.test(label),
            )
              ? "image" as const
              : semanticLabels.some((label) =>
                  /^(?:동영상|비디오|video|sent (?:a )?video)\.?$/i.test(label),
                )
                ? "video" as const
                : semanticLabels.some((label) =>
                    /^(?:이모티콘|스티커|sticker|sent (?:a )?(?:sticker|emoji))\.?$/i.test(label),
                  )
                  ? "sticker" as const
                  : undefined;
            const reelLink = node.matches('a[href*="/reel/"]')
              ? node
              : node.closest<HTMLElement>('a[href*="/reel/"]') ??
                node.querySelector<HTMLElement>('a[href*="/reel/"]');
            let inlineShare = false;
            let sharedTargetUrl = "";
            const shareContainers: HTMLElement[] = [
              node,
              ...node.querySelectorAll<HTMLElement>("*"),
            ];
            let shareContainer = node.parentElement;
            for (let depth = 0; depth < 5 && shareContainer; depth += 1) {
              shareContainers.push(shareContainer);
              if (shareContainer.matches('[role="row"], [role="listitem"]')) break;
              shareContainer = shareContainer.parentElement;
            }
            for (const candidateContainer of shareContainers.slice(0, 100)) {
              const fiberKey = Object.keys(candidateContainer).find((key) =>
                key.startsWith("__reactFiber$") || key.startsWith("__reactProps$"),
              );
              if (!fiberKey) continue;
              const root = (candidateContainer as unknown as Record<string, unknown>)[fiberKey];
              const fiberQueue: Array<{ value: unknown; depth: number }> = [
                { value: root, depth: 0 },
              ];
              const visitedFibers = new WeakSet<object>();
              for (let fiberIndex = 0; fiberIndex < fiberQueue.length && fiberIndex < 60; fiberIndex += 1) {
                const fiberEntry = fiberQueue[fiberIndex]!;
                const fiberValue = fiberEntry.value;
                if (!fiberValue || typeof fiberValue !== "object" || visitedFibers.has(fiberValue)) continue;
                visitedFibers.add(fiberValue);
                const fiber = fiberValue as Record<string, unknown>;
                const propsQueue: Array<{ value: unknown; depth: number }> = [
                  { value: fiber.memoizedProps, depth: 0 },
                  { value: fiber.pendingProps, depth: 0 },
                ];
                const visitedProps = new WeakSet<object>();
                for (let propIndex = 0; propIndex < propsQueue.length && propIndex < 120; propIndex += 1) {
                  const entry = propsQueue[propIndex]!;
                  if (!entry.value || typeof entry.value !== "object" || visitedProps.has(entry.value)) continue;
                  try {
                    if (entry.value instanceof Node || entry.value instanceof Window) continue;
                  } catch {
                    continue;
                  }
                  visitedProps.add(entry.value);
                  const record = entry.value as Record<string, unknown>;
                  try {
                    if (record.content_type === "MESSAGE_INLINE_SHARE") inlineShare = true;
                    if (typeof record.targetUrl === "string") sharedTargetUrl = record.targetUrl;
                  } catch {
                    continue;
                  }
                  if (entry.depth >= 4) continue;
                  try {
                    for (const value of Object.values(record)) {
                      if (
                        value &&
                        typeof value === "object" &&
                        !(value instanceof Node) &&
                        !(value instanceof Window)
                      ) {
                        propsQueue.push({ value, depth: entry.depth + 1 });
                      }
                    }
                  } catch {
                    continue;
                  }
                }
                if (fiberEntry.depth < 5 && fiber.child) {
                  fiberQueue.push({ value: fiber.child, depth: fiberEntry.depth + 1 });
                }
                if (fiberEntry.depth > 0 && fiber.sibling) {
                  fiberQueue.push({ value: fiber.sibling, depth: fiberEntry.depth });
                }
                if (inlineShare && sharedTargetUrl) break;
              }
              if (inlineShare && sharedTargetUrl) break;
            }
            const isReel = Boolean(
              reelLink ||
              (inlineShare && (
                /instagram\.com\/reel\//i.test(sharedTargetUrl) ||
                /instagram\.com\/p\//i.test(sharedTargetUrl) &&
                  /(?:carousel_share_child_media_id|is_ineligible_for_clips_chaining=false)/i.test(sharedTargetUrl)
              )),
            );
            const isPost = Boolean(
              inlineShare && !isReel && /instagram\.com\/p\//i.test(sharedTargetUrl),
            );
            const reelTitle = reelLink
              ? [
                  reelLink.getAttribute("aria-label"),
                  reelLink.getAttribute("title"),
                ]
                  .map((candidate) => candidate?.replaceAll("\u00a0", " ").trim())
                  .find((candidate): candidate is string => Boolean(
                    candidate &&
                    candidate.length <= 240 &&
                    !/^[a-z0-9._]+$/i.test(candidate) &&
                    !/^(?:릴스|reel|reels|watch reel|original audio)$/i.test(candidate) &&
                    !/(?:님의 릴스|(?:'s|’s) reel|reel by .+)$/i.test(candidate),
                  ))
              : undefined;
            const isVisibleChatArea =
              rect.x > Math.min(470, viewportWidth * 0.38) &&
              rect.bottom > 70 &&
              rect.y < viewportHeight - 45;
            const isBubbleShape =
              rect.width >= 20 &&
              rect.width < viewportWidth * 0.55 &&
              rect.height >= 24 &&
              rect.height < 220 &&
              style.borderRadius.includes("px");
            const hasBubbleColor =
              style.backgroundColor !== "rgba(0, 0, 0, 0)" &&
              style.backgroundColor !== "rgb(255, 255, 255)" &&
              style.backgroundColor !== "rgb(0, 0, 0)";
            const isInlineShareGroup = Boolean(
              (isReel || isPost) && node.matches('[role="group"]'),
            );
            // React props are reachable from several descendants of the same
            // share card. Treat only the semantic message-group root as the
            // message or one reel/post is emitted once per matching child.
            if ((isReel || isPost) && !isInlineShareGroup) return [];
            if (
              (!text && !detectedMediaKind) ||
              !isVisibleChatArea ||
              (!isInlineShareGroup && (!isBubbleShape || !hasBubbleColor))
            ) return [];

            const sentByMe = !isInlineShareGroup && rect.right > viewportWidth * 0.9;
            let sender = sentByMe ? "나" : "unknown";
            let senderSource: "display" | "profile" | undefined;
            let senderIdentity: string | null = null;
            let groupAriaLabel: string | null = null;
            let groupReplyTo: { sender?: string; text?: string } | undefined;
            if (!sentByMe) {
              const ownLabel = node.getAttribute("aria-label");
              if (
                ownLabel &&
                (/^.+? replied to .+$/i.test(ownLabel) ||
                  /^.+?님이 (?:회원님|.+?님)에게 (?:보낸 답장|답장했습니다)$/.test(ownLabel))
              ) {
                sender = ownLabel;
                senderSource = "display";
              }
              // Large inline-share cards can put more than nine wrappers
              // between the actual bubble and the semantic message group.
              // The group's first line is Instagram's visible sender label.
              const messageGroup = node.closest<HTMLElement>('[role="group"]');
              const groupLines = messageGroup
                ? [...new Set(
                    messageGroup.innerText
                      .split("\n")
                      .map((line) => line.trim())
                      .filter(Boolean),
                  )]
                : [];
              const groupSender = groupLines[0];
              const isReplyGroup = Boolean(
                groupSender && (/replied to/i.test(groupSender) || /답장/.test(groupSender)),
              );
              const quoteButton = node.closest<HTMLElement>('[role="button"]');
              const isQuotedReplyBubble = Boolean(
                isReplyGroup &&
                groupLines[1] === text &&
                quoteButton &&
                messageGroup?.contains(quoteButton),
              );
              if (isQuotedReplyBubble) return [];
              if (
                sender === "unknown" &&
                groupSender &&
                groupLines.length >= 2 &&
                groupSender !== text &&
                groupSender.length <= 80 &&
                !/^(?:new messages?|unread messages?|새(?:로운)? 메시지|읽지 않은 메시지)$/i.test(groupSender) &&
                !/^(?:(?:(?:19|20)\d{2}\.\s*)?\d{1,2}\.\s*\d{1,2}\.\s*|\([월화수목금토일]\)\s*|(?:오늘|어제)\s*)?(?:오전|오후)\s*\d{1,2}:\d{2}$/.test(groupSender) &&
                !/^(?:(?:today|yesterday)(?:\s+at)?\s+|(?:(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?),?\s+)?\d{1,2}:\d{2}\s*(?:am|pm)$/i.test(groupSender)
              ) {
                sender = groupSender;
                senderSource = "display";
                if (isReplyGroup) {
                  groupAriaLabel = groupSender;
                  const replyTarget =
                    groupSender.match(/^.+? replied to (.+)$/i)?.[1]?.trim() ??
                    groupSender.match(/^.+?님이 (.+?)님에게 보낸 답장$/)?.[1]?.trim() ??
                    (groupSender.match(/^.+?님이 회원님에게 답장했습니다$/) ? "나" : undefined);
                  groupReplyTo = {
                    ...(replyTarget ? { sender: replyTarget } : {}),
                    ...(groupLines[1] ? { text: groupLines[1] } : {}),
                  };
                }
              }
              let container = node.parentElement;
              const containers: HTMLElement[] = [];
              for (let depth = 0; depth < 9 && container; depth += 1) {
                containers.push(container);
                container = container.parentElement;
              }
              for (const candidateContainer of sender === "unknown" ? containers : []) {
                const containerRect = candidateContainer.getBoundingClientRect();
                const lines = [
                  ...new Set(
                    candidateContainer.innerText
                      .split("\n")
                      .map((line) => line.trim())
                      .filter(Boolean),
                  ),
                ];
                const candidate = lines[0];
                if (
                  containerRect.height < 300 &&
                  lines.length >= (detectedMediaKind ? 1 : 2) &&
                  candidate &&
                  candidate !== text &&
                  candidate.length <= 80 &&
                  !/^(?:new messages?|unread messages?|새(?:로운)? 메시지|읽지 않은 메시지)$/i.test(candidate) &&
                  !/^(?:(?:(?:19|20)\d{2}\.\s*)?\d{1,2}\.\s*\d{1,2}\.\s*|\([월화수목금토일]\)\s*|(?:오늘|어제)\s*)?(?:오전|오후)\s*\d{1,2}:\d{2}$/.test(candidate) &&
                  !/^(?:(?:today|yesterday)(?:\s+at)?\s+|(?:(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?),?\s+)?\d{1,2}:\d{2}\s*(?:am|pm)$/i.test(candidate)
                ) {
                  sender = candidate;
                  senderSource = "display";
                  break;
                }
              }
              if (sender === "unknown") {
                for (const candidateContainer of containers) {
                  const labels = [
                    ...candidateContainer.querySelectorAll<HTMLElement>('img[alt], [aria-label], [title]'),
                  ].flatMap((candidateNode) => [
                    candidateNode.getAttribute("alt"),
                    candidateNode.getAttribute("aria-label"),
                    candidateNode.getAttribute("title"),
                  ]);
                  const profileLabel = labels.find((label): label is string =>
                    Boolean(
                      label &&
                      label.length <= 120 &&
                      /프로필 사진|profile picture|보낸 메시지|프로필 페이지|open the profile page of/i.test(label),
                    ),
                  );
                  if (profileLabel) {
                    sender = profileLabel;
                    senderSource = "profile";
                    const profileHref = [
                      ...(candidateContainer.matches("a[href]") ? [candidateContainer] : []),
                      ...candidateContainer.querySelectorAll<HTMLElement>("a[href]"),
                    ].map((candidateNode) => candidateNode.getAttribute("href"))
                      .find((href) => /^\/[^/?#]+\/?(?:\?.*)?$/.test(href ?? ""));
                    senderIdentity = profileHref?.match(/^\/([^/?#]+)/)?.[1] ?? profileLabel;
                    break;
                  }
                }
              }
            }
            return [{
              text: isReel
                ? reelTitle
                  ? `${reelTitle.replace(/\s*\(릴스\)$/, "")}(릴스)`
                  : "(릴스)"
                : isPost
                  ? "(게시물)"
                  : detectedMediaKind === "image"
                    ? "사진을 보냈습니다."
                    : detectedMediaKind === "video"
                      ? "동영상을 보냈습니다."
                      : detectedMediaKind === "sticker"
                        ? "이모티콘을 보냈습니다."
                : text,
              sender,
              ...(groupAriaLabel ? { ariaLabel: groupAriaLabel } : {}),
              ...(groupReplyTo ? { replyTo: groupReplyTo } : {}),
              timestamp: null,
              ...(isReel ? { kind: "reel" as const } : {}),
              ...(isPost ? { kind: "post" as const } : {}),
              ...(!isReel && !isPost && detectedMediaKind ? { kind: detectedMediaKind } : {}),
              ...(senderSource ? { senderSource } : {}),
              ...(senderIdentity ? { senderIdentity } : {}),
              visualTop: rect.top,
              visualBottom: rect.bottom,
              visualLeft: rect.left,
            }];
          });
      });
    }

    const aliases = this.senderAliases.get(threadId) ?? new Map<string, string>();
    this.senderAliases.set(threadId, aliases);
    if (directThreadIdentity) {
      aliases.set(directThreadIdentity.username, directThreadIdentity.displayName);
    }
    rawMessages = canonicalizeInstagramSenders(rawMessages, aliases);
    const storedMessages = this.messageHistory.get(threadId);
    if (storedMessages) {
      this.messageHistory.set(
        threadId,
        storedMessages.map((message) => {
          const displayName = aliases.get(message.sender);
          return displayName ? { ...message, sender: displayName } : message;
        }),
      );
    }
    rawMessages = inheritInstagramRawSenders(rawMessages);

    const normalizedMessages = rawMessages
      .map((raw, index) => normalizeMessage(threadId, raw, index))
      .filter((item): item is ChatMessage => item !== undefined);
    return repairReplyQuoteSenders(normalizedMessages).slice(-100);
  }

  private updateSnapshot(snapshot: ChatSnapshot): void {
    this.snapshot = snapshot;
    const fingerprint = JSON.stringify(snapshot);
    if (fingerprint === this.lastFingerprint) return;
    this.lastFingerprint = fingerprint;
    this.emit("snapshot", snapshot);
  }

  private setDisconnected(detail: string): void {
    this.updateSnapshot({ ...this.snapshot, state: "disconnected", detail });
  }
}

export function isTransientInstagramNavigationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "execution context was destroyed",
    "most likely because of a navigation",
    "cannot find context with specified id",
    "frame was detached",
  ].some((fragment) => message.toLowerCase().includes(fragment));
}


function normalizeComparableText(value: string): string {
  return value.replaceAll("\u00a0", " ").replace(/\s+/g, " ").trim();
}

export function observeInstagramChanges(): void {
  const key = "__ohMyDmObserverInstalled";
  const browserWindow = window as typeof window & Record<string, unknown>;
  if (browserWindow[key]) return;
  browserWindow[key] = true;

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
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
        attributeFilter: ["aria-label", "aria-live", "href"],
      });
    }, { once: true });
  } else if (document.body) {
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
      attributeFilter: ["aria-label", "aria-live", "href"],
    });
  }
}

function dedupeConversations(items: Conversation[]): Conversation[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}
