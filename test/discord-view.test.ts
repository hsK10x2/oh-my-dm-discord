import assert from "node:assert/strict";
import test from "node:test";

import { getGroupedSelectionWindow } from "../src/ui/slash-commands.js";
import { isDirectMessage } from "../src/connectors/discord-view.js";
import type { Conversation } from "../src/domain.js";

const room = (id: string, group: string, href: string): Conversation => ({
  id,
  title: id,
  href,
  unread: false,
  group,
});

test("DM과 서버 채널을 href로 구분한다", () => {
  assert.equal(isDirectMessage(room("a", "다이렉트 메시지", "/channels/@me/1")), true);
  assert.equal(isDirectMessage(room("b", "인프 모둠", "/channels/999/1")), false);
});

test("섹션 제목이 차지하는 줄까지 세어 창 크기를 정한다", () => {
  // Four rows in two sections need six lines, not four: each section opens with
  // a heading. Given six lines all four fit.
  const items = [
    room("a", "A", "/channels/@me/1"),
    room("b", "A", "/channels/@me/2"),
    room("c", "B", "/channels/9/1"),
    room("d", "B", "/channels/9/2"),
  ];
  const all = getGroupedSelectionWindow(items, 0, 6, (item) => item.group);
  assert.deepEqual(all.items.map((i) => i.id), ["a", "b", "c", "d"]);

  // With only four lines the two headings leave room for two rows.
  const tight = getGroupedSelectionWindow(items, 0, 4, (item) => item.group);
  assert.ok(tight.items.length < 4, `expected fewer than 4, got ${tight.items.length}`);
});

test("선택한 행은 창이 좁아도 항상 보인다", () => {
  const items = Array.from({ length: 40 }, (_, index) =>
    room(`r${index}`, index < 20 ? "A" : "B", "/channels/9/1"),
  );
  for (const selected of [0, 19, 20, 39]) {
    const window = getGroupedSelectionWindow(items, selected, 5, (item) => item.group);
    assert.ok(
      selected >= window.start && selected < window.end,
      `selected ${selected} outside [${window.start}, ${window.end})`,
    );
  }
});

test("그룹이 없으면 한 행이 한 줄만 쓴다", () => {
  const items = Array.from({ length: 10 }, (_, index) => ({
    ...room(`r${index}`, "", "/channels/@me/1"),
    group: undefined,
  }));
  const window = getGroupedSelectionWindow(items, 0, 4, (item) => item.group);
  assert.equal(window.items.length, 4);
});

test("빈 목록도 안전하게 처리한다", () => {
  const window = getGroupedSelectionWindow([], 0, 5, () => undefined);
  assert.deepEqual(window, { items: [], start: 0, end: 0 });
});
