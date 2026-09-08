import { EventEmitter } from "node:events";
import fs from "node:fs/promises";

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
  COMPOSER_SELECTOR,
  channelHrefParts,
  DM_ROW_SELECTOR,
  GUILD_CHANNEL_SELECTOR,
  GUILD_RAIL_SELECTOR,
  MESSAGE_LIST_SELECTOR,
  MESSAGE_ROW_SELECTOR,
  inheritDiscordGroupedSenders,
  mergeDiscordConversations,
  mergeDiscordMessages,
  expandDiscordFolders,
  isDiscordGuildId,
  normalizeDiscordChannel,
  normalizeDiscordConversation,
  normalizeDiscordMessage,
  observeDiscordChanges,
  readDiscordConversationRows,
  readDiscordGuildChannels,
  readDiscordGuildRail,
  readDiscordPageState,
  readDiscordCurrentUser,
  readDiscordMessageRows,
  type RawDiscordConversation,
  type RawDiscordGuild,
  type RawDiscordMessage,
} from "./discord-dom.js";

const APP_URL = "https://discord.com/channels/@me";
const MESSAGE_LIMIT = 500;

export interface DiscordWebOptions {
  profileDir: string;
  headless?: boolean;
  cloneProfileWhenLocked?: boolean;
}

export class DiscordWebConnector extends EventEmitter implements ChatConnector {
  private context?: BrowserContext;
  private page?: Page;
  private refreshTimer?: NodeJS.Timeout;
  private refreshRunning = false;
  private refreshAgain = false;
  private lastFingerprint = "";
  private browserLabel = "Chromium";
  private currentUser: { id?: string | null; name?: string | null } = {};
  private loadingOlder = false;
  private stopped = false;
  private desiredRunning = false;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private temporaryProfileDir?: string;
  private readonly messageHistory = new Map<string, ChatMessage[]>();
  /** Guild id -> name, filled the first time the rail is read. */
  private readonly guilds = new Map<string, string>();
  private readonly visitedGuilds = new Set<string>();
  private guildChannels: Conversation[] = [];
  private foldersExpanded = false;
  private snapshot: ChatSnapshot = {
    state: "starting",
    conversations: [],
    messages: [],
    detail: "브라우저 엔진을 시작하는 중",
  };

  public constructor(private readonly options: DiscordWebOptions) {
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

  public stop(): Promise<void> {
    this.desiredRunning = false;
    this.stopped = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    return this.enqueueLifecycle(async () => {
      // Mirrors the Instagram connector: React can remount immediately after
      // an effect cleanup, and the newest intent has to win.
      if (this.desiredRunning) return;
      await this.context?.close();
      this.context = undefined;
      this.page = undefined;
      await this.removeTemporaryProfile();
    });
  }

  public async openConversation(id: string): Promise<void> {
    const page = await this.requireReadyPage();
    const conversation = this.snapshot.conversations.find((item) => item.id === id);
    if (!conversation) throw new Error(`대화를 찾을 수 없습니다: ${id}`);

    // A DM href is /channels/@me/<id> and a guild channel is
    // /channels/<guild>/<id>, so the stored href is what makes both routable.
    const target = conversation.href.startsWith("/")
      ? `https://discord.com${conversation.href}`
      : `${APP_URL}/${id}`;
    await page.goto(target, { waitUntil: "domcontentloaded" });
    // Discord routes instantly but hydrates the message list afterwards.
    // Publishing during that gap would show an empty conversation.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await this.readVisibleMessages(page, id)).length > 0) break;
      await page.waitForTimeout(150);
    }
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    while (this.refreshRunning) await page.waitForTimeout(25);
    await this.performRefresh();
  }

  public async sendMessage(text: string): Promise<void> {
    const page = await this.requireReadyPage();
    const message = text.trim();
    if (!message) return;
    const channelId = channelIdFromUrl(page.url());
    if (!channelId) throw new Error("먼저 대화를 선택하세요.");

    const composer = page.locator(COMPOSER_SELECTOR).last();
    await composer.waitFor({ state: "visible", timeout: 5_000 });
    await composer.click();
    // Discord's Slate editor ignores value assignment, so the text has to be
    // typed. fill() works because Playwright dispatches real input events.
    await composer.fill(message);
    await composer.press("Enter");

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await page.waitForTimeout(50);
      const visible = await this.readVisibleMessages(page, channelId);
      const last = visible.at(-1);
      if (last && last.text === message) {
        // The confirmed row is authoritative about which account we are.
        if (last.sender !== "나" && last.sender !== "unknown") {
          this.currentUser = { ...this.currentUser, name: last.sender };
          this.rememberOwnSender(last.sender);
        }
        const messages = mergeDiscordMessages(
          this.messageHistory.get(channelId) ?? [],
          visible,
        ).slice(-MESSAGE_LIMIT);
        this.messageHistory.set(channelId, messages);
        this.updateSnapshot({
          ...this.snapshot,
          state: "connected",
          activeConversationId: channelId,
          messages,
        });
        return;
      }
    }
    this.scheduleRefresh("sent-message-fallback", 0);
  }

  public async loadOlderMessages(): Promise<number> {
    const page = await this.requireReadyPage();
    const channelId = channelIdFromUrl(page.url());
    if (!channelId) return 0;
    const before = this.messageHistory.get(channelId)?.length ?? 0;

    this.loadingOlder = true;
    try {
      const scroller = page.locator(MESSAGE_LIST_SELECTOR).last();
      await scroller.evaluate((element) => {
        const list = element as HTMLElement;
        const viewport = list.closest("[class*='scroller']") ?? list.parentElement ?? list;
        (viewport as HTMLElement).scrollTop = 0;
      });
      // Discord fetches the previous page after the scroller hits the top.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await page.waitForTimeout(150);
        const visible = await this.readVisibleMessages(page, channelId);
        const merged = mergeDiscordMessages(
          this.messageHistory.get(channelId) ?? [],
          visible,
        ).slice(0, MESSAGE_LIMIT);
        this.messageHistory.set(channelId, merged);
        if (merged.length > before) {
          this.updateSnapshot({ ...this.snapshot, state: "connected", messages: merged });
          return merged.length - before;
        }
      }
      return 0;
    } finally {
      this.loadingOlder = false;
    }
  }

  /**
   * Pulls in one more server's channels per call. Visiting every server up
   * front would mean a full navigation and render for each one, so the list
   * grows as the user scrolls instead.
   */
  public async loadMoreConversations(): Promise<number> {
    const page = await this.requireReadyPage();
    const before = this.snapshot.conversations.length;

    // Servers tucked inside a folder are hidden until it is opened, which is
    // why an untouched rail can show only a couple of entries.
    if (!this.foldersExpanded) {
      await page.evaluate(expandDiscordFolders).catch(() => 0);
      await page.waitForTimeout(400);
      this.foldersExpanded = true;
    }
    await this.readGuildRail(page);

    const next = [...this.guilds.keys()].find((id) => !this.visitedGuilds.has(id));
    if (next) await this.harvestGuildChannels(page, next);
    else {
      await page.locator(DM_ROW_SELECTOR).last().scrollIntoViewIfNeeded().catch(() => undefined);
      await page.waitForTimeout(200);
    }

    // Navigating between guilds schedules its own refresh, and performRefresh()
    // is a no-op both while one is running and before the app shell has
    // re-rendered. Without waiting for either, this round's channels would only
    // reach the snapshot on the next call.
    await this.waitForAppShell(page);
    while (this.refreshRunning) await page.waitForTimeout(25);
    await this.performRefresh();
    return Math.max(0, this.snapshot.conversations.length - before);
  }

  private async waitForAppShell(page: Page): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const ready = await page.evaluate(readDiscordPageState).catch(() => null);
      if (ready?.appReady) return;
      await page.waitForTimeout(150);
    }
  }

  private async readGuildRail(page: Page): Promise<void> {
    const rail = await page
      .locator(GUILD_RAIL_SELECTOR)
      .evaluateAll(readDiscordGuildRail)
      .catch(() => [] as RawDiscordGuild[]) as RawDiscordGuild[];
    for (const guild of rail) {
      if (!isDiscordGuildId(guild.id)) continue;
      this.guilds.set(guild.id, guild.name?.trim() || guild.id);
    }
  }

  private async harvestGuildChannels(page: Page, guildId: string): Promise<void> {
    this.visitedGuilds.add(guildId);
    const returnTo = page.url();
    try {
      await page.goto(`https://discord.com/channels/${guildId}`, {
        waitUntil: "domcontentloaded",
      });
      // The channel sidebar renders after the route settles.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await page.waitForTimeout(200);
        if (await page.locator(GUILD_CHANNEL_SELECTOR).count()) break;
      }
      const rows = await page
        .locator(GUILD_CHANNEL_SELECTOR)
        .evaluateAll(readDiscordGuildChannels)
        .catch(() => [] as RawDiscordConversation[]) as RawDiscordConversation[];
      const name = this.guilds.get(guildId);
      const channels = rows
        .map((row) => normalizeDiscordChannel(row, name))
        .filter((item): item is Conversation => item !== undefined);
      this.guildChannels = mergeDiscordConversations(this.guildChannels, channels);
    } finally {
      await page.goto(returnTo, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    }
  }

  private async startBrowser(): Promise<void> {
    await fs.mkdir(this.options.profileDir, { recursive: true, mode: 0o700 });
    const headless = this.options.headless ?? true;
    const browser = resolveBrowserExecutable();
    this.browserLabel = `${browser.label}${headless ? " Headless" : ""}`;
    const launch = (profileDir: string) => chromium.launchPersistentContext(profileDir, {
      executablePath: browser.executablePath,
      headless,
      viewport: { width: 1280, height: 860 },
    });

    let runtimeProfileDir = this.options.profileDir;
    try {
      try {
        this.context = await launch(runtimeProfileDir);
      } catch (error) {
        if (!this.options.cloneProfileWhenLocked || !isProfileLockError(error)) throw error;
        const clone = await cloneBrowserProfile(
          this.options.profileDir,
          undefined,
          "oh-my-dm-discord-",
        );
        runtimeProfileDir = clone.profileDir;
        this.temporaryProfileDir = clone.cleanupDir;
        this.browserLabel = `${this.browserLabel} · shared session`;
        this.context = await launch(runtimeProfileDir);
      }
    } catch (error) {
      this.cancelScheduledRefresh();
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
      await this.page.goto(APP_URL, { waitUntil: "domcontentloaded" });
      this.scheduleRefresh("startup", 0);
    } catch (error) {
      this.cancelScheduledRefresh();
      await this.context.close().catch(() => undefined);
      this.context = undefined;
      this.page = undefined;
      await this.removeTemporaryProfile();
      const detail = error instanceof Error ? error.message : String(error);
      this.updateSnapshot({ ...this.snapshot, state: "error", detail });
      throw error;
    }
  }

  private cancelScheduledRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
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

  private requirePage(): Page {
    const page = this.getUsablePage();
    if (!page) throw new Error("Discord 커넥터가 시작되지 않았습니다.");
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
    await page.addInitScript(observeDiscordChanges);
    await page.evaluate(observeDiscordChanges).catch(() => undefined);
  }

  private scheduleRefresh(_reason: string, delay = 180): void {
    if (this.stopped) return;
    if (this.loadingOlder) return;
    // Discord's gateway is chatty; coalesce bursts into one bounded refresh
    // instead of letting each frame push the timer further out.
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
      // start() can fail, and stop() can run, after a refresh was already
      // scheduled. Emitting on a torn-down connector would raise an
      // unhandled 'error' event and take the whole CLI down with it.
      const page = this.getUsablePage();
      if (!page) return;
      const url = page.url();
      const pageState = await page
        .evaluate(readDiscordPageState)
        .catch(() => ({ path: new URL(url).pathname, loginPage: false, appReady: false }));

      if (pageState.loginPage) {
        this.updateSnapshot({
          ...this.snapshot,
          state: "login-required",
          detail: "Playwright Chromium에서 Discord 로그인을 완료하세요: oh-my-dm login discord",
        });
        return;
      }
      if (!pageState.appReady) {
        // Either the app shell is still mounting or the router has not yet
        // redirected an expired session. Both resolve on their own, so keep
        // polling instead of claiming a connection that may not exist.
        this.updateSnapshot({
          ...this.snapshot,
          state: "starting",
          detail: `${this.browserLabel} · Discord를 여는 중`,
        });
        this.scheduleRefresh("app-shell", 700);
        return;
      }

      if (!this.currentUser.id && !this.currentUser.name) {
        this.currentUser =
          (await page.evaluate(readDiscordCurrentUser).catch(() => null)) ?? {};
      }

      const rawConversations = await page
        .locator(DM_ROW_SELECTOR)
        .evaluateAll(readDiscordConversationRows) as RawDiscordConversation[];
      const captured = dedupeConversations(
        rawConversations
          .map(normalizeDiscordConversation)
          .filter((item): item is Conversation => item !== undefined),
      );
      // Guild channels are only re-read when the user asks for more, so they
      // are kept aside and appended rather than being dropped by a DM-only read.
      const conversations = mergeDiscordConversations(
        mergeDiscordConversations(this.snapshot.conversations, captured),
        this.guildChannels,
      );

      const activeConversationId = channelIdFromUrl(url);
      const visibleMessages = activeConversationId
        ? await this.readVisibleMessages(page, activeConversationId)
        : [];
      let messages: ChatMessage[] = [];
      if (activeConversationId) {
        const merged = mergeDiscordMessages(
          this.messageHistory.get(activeConversationId) ?? [],
          visibleMessages,
        );
        messages = this.loadingOlder
          ? merged.slice(0, MESSAGE_LIMIT)
          : merged.slice(-MESSAGE_LIMIT);
        this.messageHistory.set(activeConversationId, messages);
      }

      this.updateSnapshot({
        state: "connected",
        conversations,
        activeConversationId,
        messages,
        detail: conversations.length
          ? `${this.browserLabel} · DOM + 게이트웨이 이벤트 감지 중`
          : `${this.browserLabel} · 대화 목록을 기다리는 중`,
      });
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (isTransientDiscordNavigationError(normalized)) {
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

  private async readVisibleMessages(page: Page, channelId: string): Promise<ChatMessage[]> {
    const rawMessages = await page
      .locator(MESSAGE_ROW_SELECTOR)
      .evaluateAll(readDiscordMessageRows)
      .catch(() => [] as RawDiscordMessage[]) as RawDiscordMessage[];
    return inheritDiscordGroupedSenders(rawMessages)
      .map((raw, index) => normalizeDiscordMessage(channelId, raw, index, this.currentUser))
      .filter((message): message is ChatMessage => message !== undefined);
  }

  private rememberOwnSender(sender: string): void {
    for (const [threadId, messages] of this.messageHistory) {
      this.messageHistory.set(
        threadId,
        messages.map((message) =>
          message.sender === sender ? { ...message, sender: "나" } : message,
        ),
      );
    }
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

/**
 * Matches a DM (/channels/@me/<id>) and a guild channel
 * (/channels/<guild>/<id>) alike — the trailing snowflake is the channel in
 * both, and it is what keys message history, sending and the active row.
 */
export function channelIdFromUrl(url: string): string | undefined {
  return channelHrefParts(url).channelId;
}

export function isTransientDiscordNavigationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "execution context was destroyed",
    "most likely because of a navigation",
    "cannot find context with specified id",
    "frame was detached",
  ].some((fragment) => message.toLowerCase().includes(fragment));
}

function dedupeConversations(items: Conversation[]): Conversation[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}
