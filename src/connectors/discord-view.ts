import { EventEmitter } from "node:events";

import type { ChatConnector, ChatSnapshot, Conversation } from "../domain.js";
import type { DiscordWebConnector } from "./discord-web.js";

export type DiscordViewKind = "dm" | "guild";

export function isDirectMessage(conversation: Conversation): boolean {
  return conversation.href.startsWith("/channels/@me/");
}

/**
 * Presents one half of a Discord session as its own connector, so the TUI shows
 * direct messages and server channels as separate tabs.
 *
 * A busy account produces a couple of hundred rooms, and a single list that long
 * is unusable in a terminal however it is sorted. Splitting the two apart is
 * what the tab strip already does well, and it costs nothing extra: both views
 * share one underlying connector, so there is still a single browser and a
 * single login.
 */
export class DiscordViewConnector extends EventEmitter implements ChatConnector {
  private started = false;

  public constructor(
    private readonly base: DiscordWebConnector,
    private readonly kind: DiscordViewKind,
  ) {
    super();
    this.base.on("snapshot", () => this.emit("snapshot", this.getSnapshot()));
    this.base.on("error", (error) => this.emit("error", error));
  }

  public getSnapshot(): ChatSnapshot {
    const snapshot = this.base.getSnapshot();
    const conversations = snapshot.conversations.filter((conversation) =>
      this.kind === "dm" ? isDirectMessage(conversation) : !isDirectMessage(conversation),
    );
    // The active conversation belongs to whichever view holds it; the other
    // must not claim its messages or highlight a row it does not show.
    const owned = conversations.some(
      (conversation) => conversation.id === snapshot.activeConversationId,
    );
    return {
      ...snapshot,
      conversations,
      activeConversationId: owned ? snapshot.activeConversationId : undefined,
      messages: owned ? snapshot.messages : [],
      detail: this.describe(snapshot, conversations.length),
    };
  }

  public async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // Both views drive the same connector; whichever starts first wins and the
    // second is a no-op rather than a second browser.
    await this.base.start();
  }

  public async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.base.stop();
  }

  public refresh(): Promise<void> {
    return this.base.refresh();
  }

  public openConversation(id: string): Promise<void> {
    return this.base.openConversation(id);
  }

  public sendMessage(text: string): Promise<void> {
    return this.base.sendMessage(text);
  }

  public loadOlderMessages(): Promise<number> {
    return this.base.loadOlderMessages();
  }

  public loadMoreConversations(): Promise<number> {
    return this.base.loadMoreConversations();
  }

  private describe(snapshot: ChatSnapshot, count: number): string | undefined {
    if (snapshot.state !== "connected") return snapshot.detail;
    if (this.kind === "dm") return `${count}개 대화`;
    const servers = new Set(
      snapshot.conversations
        .filter((conversation) => !isDirectMessage(conversation))
        .map((conversation) => conversation.group),
    );
    // The sweep fills this in over the first minute or so, and saying how far it
    // has come is more useful than a static label.
    return `서버 ${servers.size}개 · 채널 ${count}개`;
  }
}
