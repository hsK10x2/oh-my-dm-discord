import assert from "node:assert/strict";
import test from "node:test";

import {
  DiscordWebConnector,
  channelIdFromUrl,
  isTransientDiscordNavigationError,
} from "../src/connectors/discord-web.js";

test("DM URL에서 활성 채널 id를 읽는다", () => {
  assert.equal(channelIdFromUrl("https://discord.com/channels/@me/123"), "123");
  assert.equal(channelIdFromUrl("https://discord.com/channels/@me"), undefined);
  assert.equal(channelIdFromUrl("https://discord.com/login"), undefined);
});

test("navigation 중 사라진 실행 컨텍스트는 일시적 오류로 본다", () => {
  assert.equal(
    isTransientDiscordNavigationError(
      new Error("Execution context was destroyed, most likely because of a navigation"),
    ),
    true,
  );
  assert.equal(isTransientDiscordNavigationError(new Error("Frame was detached")), true);
  assert.equal(isTransientDiscordNavigationError(new Error("net::ERR_NAME_NOT_RESOLVED")), false);
});

test("브라우저가 없는 상태의 refresh는 error 이벤트를 내지 않는다", async () => {
  // A refresh scheduled just before start() failed used to reach requirePage()
  // and emit 'error'. With no listener attached — which is exactly the case in
  // `oh-my-dm login` — EventEmitter turns that into a process crash.
  const connector = new DiscordWebConnector({ profileDir: "unused", headless: true });
  const errors: Error[] = [];
  connector.on("error", (error) => errors.push(error));

  await (connector as unknown as { performRefresh(): Promise<void> }).performRefresh();

  assert.deepEqual(errors, []);
  assert.equal(connector.getSnapshot().state, "starting");
});

test("연결 전에도 스냅샷을 안전하게 돌려준다", () => {
  const connector = new DiscordWebConnector({ profileDir: "unused", headless: true });
  const snapshot = connector.getSnapshot();
  assert.equal(snapshot.state, "starting");
  assert.deepEqual(snapshot.conversations, []);
  assert.deepEqual(snapshot.messages, []);
});
