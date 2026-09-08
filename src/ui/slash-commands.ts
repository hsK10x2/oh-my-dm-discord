import type { AppLanguage } from "./i18n.js";

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  usage: string;
}

const COMMANDS: Array<Omit<SlashCommand, "description"> & { descriptions: Record<AppLanguage, string> }> = [
  { name: "help", aliases: ["h"], descriptions: { ko: "명령과 단축키 보기", en: "Show commands and shortcuts" }, usage: "/help" },
  { name: "open", aliases: ["o"], descriptions: { ko: "이름으로 대화방 열기", en: "Open a conversation by name" }, usage: "/open <name>" },
  {
    name: "conversations",
    aliases: ["chats", "ls"],
    descriptions: { ko: "대화방 목록 보기", en: "Show conversations" },
    usage: "/conversations",
  },
  { name: "unread", aliases: ["u"], descriptions: { ko: "안 읽은 대화만 보기", en: "Show unread conversations" }, usage: "/unread" },
  { name: "all", aliases: ["a"], descriptions: { ko: "모든 대화 보기", en: "Show all conversations" }, usage: "/all" },
  {
    name: "connectors",
    aliases: ["status", "s"],
    descriptions: { ko: "채팅 connector 연결 상태 보기", en: "Show connector status" },
    usage: "/connectors",
  },
  {
    name: "history",
    aliases: ["older"],
    descriptions: { ko: "과거 대화 내역 열기", en: "Open message history" },
    usage: "/history",
  },
  { name: "model", aliases: ["models"], descriptions: { ko: "표시할 모델 선택", en: "Choose a display model" }, usage: "/model [name]" },
  { name: "theme", aliases: ["themes"], descriptions: { ko: "UI 색상 테마 선택", en: "Choose a UI theme" }, usage: "/theme [name]" },
  { name: "language", aliases: ["lang"], descriptions: { ko: "표시 언어 선택", en: "Choose the display language" }, usage: "/language [auto|ko|en]" },
  { name: "refresh", aliases: ["r"], descriptions: { ko: "connector 화면 다시 읽기", en: "Refresh connector views" }, usage: "/refresh" },
  { name: "update", descriptions: { ko: "oh-my-dm 최신 버전 설치", en: "Install the latest oh-my-dm version" }, usage: "/update" },
  { name: "clear", aliases: ["c"], descriptions: { ko: "현재 메시지 화면 비우기", en: "Clear the current message view" }, usage: "/clear" },
  { name: "exit", aliases: ["quit", "q"], descriptions: { ko: "oh-my-dm 종료", en: "Exit oh-my-dm" }, usage: "/exit" },
];

export function getSlashCommands(language: AppLanguage = "ko"): SlashCommand[] {
  return COMMANDS.map(({ descriptions, ...command }) => ({
    ...command,
    description: descriptions[language],
  }));
}

export const SLASH_COMMANDS = getSlashCommands("ko");

export type ParsedSubmission =
  | { kind: "empty" }
  | { kind: "message"; text: string }
  | { kind: "command"; name: string; args: string[] };

export function parseSubmission(value: string): ParsedSubmission {
  const trimmed = value.trim();
  if (!trimmed) return { kind: "empty" };
  if (trimmed.startsWith("//")) return { kind: "message", text: trimmed.slice(1) };
  if (!trimmed.startsWith("/")) return { kind: "message", text: trimmed };

  const [name = "", ...args] = trimmed.slice(1).trimStart().split(/\s+/);
  return { kind: "command", name: name.toLowerCase(), args };
}

export function filterSlashCommands(value: string, language: AppLanguage = "ko"): SlashCommand[] {
  const commands = getSlashCommands(language);
  if (!value.startsWith("/") || value.startsWith("//")) return [];
  const query = value.slice(1).trimStart().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!query) return commands;

  return commands.filter(
    (command) =>
      command.name.startsWith(query) ||
      command.aliases?.some((alias) => alias.startsWith(query)) ||
      command.description.toLowerCase().includes(query),
  );
}

export function findSlashCommand(name: string): SlashCommand | undefined {
  return getSlashCommands().find(
    (command) => command.name === name || command.aliases?.includes(name),
  );
}

export function wrapSelectionIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (index + delta + length) % length;
}

export interface SelectionWindow<T> {
  items: T[];
  start: number;
  end: number;
}

/**
 * Picks the slice of a grouped list that fits in `availableLines`.
 *
 * A row costs one line, and a row that opens a new section costs two: the
 * heading sits above it. Sizing the window by row count alone overflows the
 * fixed-height box by exactly the number of headings on screen, and Ink
 * responds by collapsing an arbitrary row to zero height — selectable but
 * invisible.
 */
export function getGroupedSelectionWindow<T>(
  items: T[],
  selectedIndex: number,
  availableLines: number,
  groupOf: (item: T) => string | undefined,
): SelectionWindow<T> {
  const lines = Math.max(1, availableLines);
  const costAt = (index: number): number => {
    const group = groupOf(items[index]!);
    if (!group) return 1;
    // The first row always opens its section.
    if (index === 0) return 2;
    return groupOf(items[index - 1]!) === group ? 1 : 2;
  };

  // Grow backwards from the selection so it stays visible, then forwards
  // with whatever room is left.
  const anchor = Math.min(Math.max(0, selectedIndex), Math.max(0, items.length - 1));
  if (items.length === 0) return { items: [], start: 0, end: 0 };

  let start = anchor;
  let end = anchor + 1;
  let used = costAt(anchor);
  for (;;) {
    let grew = false;
    if (start > 0 && used + costAt(start - 1) <= lines) {
      start -= 1;
      used += costAt(start);
      grew = true;
    }
    if (end < items.length && used + costAt(end) <= lines) {
      used += costAt(end);
      end += 1;
      grew = true;
    }
    if (!grew) break;
  }
  return { items: items.slice(start, end), start, end };
}

export function getSelectionWindow<T>(
  items: T[],
  selectedIndex: number,
  windowSize: number,
): SelectionWindow<T> {
  const size = Math.max(1, Math.min(windowSize, items.length));
  const maxStart = Math.max(0, items.length - size);
  const start = Math.min(maxStart, Math.max(0, selectedIndex - size + 1));
  const end = start + size;
  return { items: items.slice(start, end), start, end };
}
