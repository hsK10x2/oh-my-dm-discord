import assert from "node:assert/strict";
import test from "node:test";

import type { ChatMessage } from "../src/domain.js";
import {
  channelIdFromHref,
  inheritDiscordGroupedSenders,
  mergeDiscordConversations,
  mergeDiscordMessages,
  messageIdFromRowId,
  normalizeDiscordConversation,
  normalizeDiscordMessage,
  type RawDiscordMessage,
} from "../src/connectors/discord-dom.js";

test("DM URL에서 채널 id를 추출한다", () => {
  assert.equal(channelIdFromHref("/channels/@me/123456789"), "123456789");
  assert.equal(channelIdFromHref("https://discord.com/channels/@me/987/111"), "987");
  assert.equal(channelIdFromHref("/channels/555/666"), undefined);
  assert.equal(channelIdFromHref("/store"), undefined);
});

test("행 id에서 메시지 snowflake를 추출한다", () => {
  assert.equal(messageIdFromRowId("chat-messages-111-222"), "222");
  assert.equal(messageIdFromRowId("chat-messages-222"), "222");
  assert.equal(messageIdFromRowId("chat-messages-divider"), undefined);
});

test("DM 행을 대화로 정규화하고 안 읽음 표식을 읽는다", () => {
  const conversation = normalizeDiscordConversation({
    href: "/channels/@me/42",
    title: "  friend  ",
    preview: "안녕\n하세요",
    unreadHint: true,
  });
  assert.equal(conversation?.id, "42");
  assert.equal(conversation?.title, "friend");
  assert.equal(conversation?.preview, "안녕 하세요");
  assert.equal(conversation?.unread, true);

  assert.equal(normalizeDiscordConversation({ href: "/channels/@me/9", title: "  " }), undefined);
  assert.equal(normalizeDiscordConversation({ href: "/store", title: "x" }), undefined);
});

test("연속 메시지는 그룹 헤더의 작성자를 물려받는다", () => {
  const rows: RawDiscordMessage[] = [
    { rowId: "chat-messages-1-1", text: "첫 줄", sender: "friend", authorId: "77" },
    { rowId: "chat-messages-1-2", text: "둘째 줄" },
    { rowId: "chat-messages-1-3", text: "셋째 줄" },
    { rowId: "chat-messages-1-4", text: "내 답장", sender: "me", authorId: "99" },
    { rowId: "chat-messages-1-5", text: "이어서" },
  ];
  const inherited = inheritDiscordGroupedSenders(rows);
  assert.deepEqual(
    inherited.map((row) => row.sender),
    ["friend", "friend", "friend", "me", "me"],
  );
  assert.deepEqual(
    inherited.map((row) => row.authorId),
    ["77", "77", "77", "99", "99"],
  );
});

test("시스템 행은 작성자를 물려받지도 물려주지도 않는다", () => {
  const inherited = inheritDiscordGroupedSenders([
    { rowId: "chat-messages-1-1", text: "안녕", sender: "friend", authorId: "77" },
    { rowId: "chat-messages-1-2", text: "핀 고정됨", system: true },
    { rowId: "chat-messages-1-3", text: "계속" },
  ]);
  assert.equal(inherited[1]?.sender, undefined);
  assert.equal(inherited[2]?.sender, "friend");
});

test("내 계정의 메시지는 나로 표시하고 메시지 id는 snowflake를 쓴다", () => {
  const mine = normalizeDiscordMessage(
    "10",
    { rowId: "chat-messages-10-555", text: "내 메시지", sender: "myname", authorId: "99" },
    0,
    { id: "99" },
  );
  assert.equal(mine?.id, "555");
  assert.equal(mine?.threadId, "10");
  assert.equal(mine?.sender, "나");

  const theirs = normalizeDiscordMessage(
    "10",
    { rowId: "chat-messages-10-556", text: "네 메시지", sender: "friend", authorId: "77" },
    1,
    { id: "99" },
  );
  assert.equal(theirs?.sender, "friend");
});

test("답장 컨텍스트가 있으면 reply 종류로 정규화한다", () => {
  const reply = normalizeDiscordMessage(
    "10",
    {
      rowId: "chat-messages-10-600",
      text: "그래",
      sender: "friend",
      authorId: "77",
      replySender: "myname",
      replyText: "밥 먹었어?",
    },
    0,
  );
  assert.equal(reply?.kind, "reply");
  assert.equal(reply?.replyTo?.sender, "myname");
  assert.equal(reply?.replyTo?.text, "밥 먹었어?");
});

test("빈 본문은 메시지로 만들지 않는다", () => {
  assert.equal(
    normalizeDiscordMessage("10", { rowId: "chat-messages-10-1", text: "   " }, 0),
    undefined,
  );
});

const message = (id: string, text: string, sender = "friend"): ChatMessage => ({
  id,
  threadId: "10",
  kind: "text",
  sender,
  text,
});

test("같은 id의 메시지는 중복되지 않고 제자리에서 갱신된다", () => {
  const merged = mergeDiscordMessages(
    [message("100", "안녕"), message("101", "잘 지내?")],
    [message("101", "잘 지내? (수정됨)")],
  );
  assert.deepEqual(merged.map((item) => item.id), ["100", "101"]);
  assert.equal(merged[1]?.text, "잘 지내? (수정됨)");
});

test("새 메시지는 뒤에, 과거 메시지는 앞에 붙인다", () => {
  const merged = mergeDiscordMessages(
    [message("200", "가운데")],
    [message("100", "과거"), message("200", "가운데"), message("300", "최신")],
  );
  assert.deepEqual(merged.map((item) => item.id), ["100", "200", "300"]);
});

test("자릿수가 다른 snowflake도 시간순으로 비교한다", () => {
  const merged = mergeDiscordMessages(
    [message("1000000000000000000", "기준")],
    [message("999999999999999999", "더 과거")],
  );
  assert.deepEqual(
    merged.map((item) => item.id),
    ["999999999999999999", "1000000000000000000"],
  );
});

test("한쪽이 비어 있으면 다른 쪽을 그대로 쓴다", () => {
  assert.deepEqual(mergeDiscordMessages([], [message("1", "a")]).length, 1);
  assert.deepEqual(mergeDiscordMessages([message("1", "a")], []).length, 1);
});

test("대화 목록은 기존 순서를 지키며 새 대화만 뒤에 추가한다", () => {
  const merged = mergeDiscordConversations(
    [
      { id: "1", title: "a", href: "/channels/@me/1", unread: false },
      { id: "2", title: "b", href: "/channels/@me/2", unread: false },
    ],
    [
      { id: "2", title: "b", href: "/channels/@me/2", unread: true },
      { id: "3", title: "c", href: "/channels/@me/3", unread: false },
    ],
  );
  assert.deepEqual(merged.map((item) => item.id), ["1", "2", "3"]);
  assert.equal(merged[1]?.unread, true);
});

test("커스텀 아바타가 없어 id를 못 얻으면 표시 이름으로 나를 판별한다", () => {
  // The account panel renders a bundled /assets/*.png when the user has no
  // custom avatar, so no snowflake is available and only the name can match.
  const mine = normalizeDiscordMessage(
    "10",
    { rowId: "chat-messages-10-700", text: "내 메시지", sender: "Yejun Kim (김예준)" },
    0,
    { name: "Yejun Kim (김예준)" },
  );
  assert.equal(mine?.sender, "나");

  const theirs = normalizeDiscordMessage(
    "10",
    { rowId: "chat-messages-10-701", text: "네 메시지", sender: "다른사람" },
    1,
    { name: "Yejun Kim (김예준)" },
  );
  assert.equal(theirs?.sender, "다른사람");
});

test("내 이름을 향한 답장은 나에게 답장으로 표시한다", () => {
  const reply = normalizeDiscordMessage(
    "10",
    {
      rowId: "chat-messages-10-702",
      text: "ㅇㅇ",
      sender: "friend",
      replySender: "Yejun Kim (김예준)",
      replyText: "밥 먹었어?",
    },
    0,
    { name: "Yejun Kim (김예준)" },
  );
  assert.equal(reply?.replyTo?.sender, "나");
});

test("이미 확인된 발신자를 unknown이 덮어쓰지 않는다", () => {
  // Scrolling can push a group header out of view, so a re-read of the topmost
  // row arrives with no author at all.
  const merged = mergeDiscordMessages(
    [message("100", "안녕", "friend")],
    [message("100", "안녕", "unknown")],
  );
  assert.equal(merged[0]?.sender, "friend");

  const forward = mergeDiscordMessages(
    [message("100", "안녕", "unknown")],
    [message("100", "안녕", "friend")],
  );
  assert.equal(forward[0]?.sender, "friend");
});

test("시스템 알림은 작성자 없는 일반 메시지가 아니라 system으로 분류한다", () => {
  const notice = normalizeDiscordMessage(
    "10",
    {
      rowId: "chat-messages-10-800",
      text: "Yejun Kim (김예준) 님이 그룹 이름을 변경했어요.",
      system: true,
    },
    0,
  );
  assert.equal(notice?.kind, "system");
  assert.notEqual(notice?.sender, "unknown");
});
