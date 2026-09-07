#!/usr/bin/env node
import fs from "node:fs/promises";

import { render } from "ink";
import React from "react";

import { resolveBrowserExecutable } from "./browser/resolve-browser.js";
import { getAppPaths } from "./config.js";
import { DiscordWebConnector } from "./connectors/discord-web.js";
import { InstagramWebConnector } from "./connectors/instagram-web.js";
import { KakaoNativeConnector } from "./connectors/kakao-native.js";
import { UnifiedChatConnector } from "./connectors/unified.js";
import { SettingsStore } from "./storage/settings-store.js";
import { App } from "./ui/app.js";
import { resolveLanguage } from "./ui/i18n.js";
import { FORK_UPDATE_INSTRUCTIONS } from "./update.js";

const paths = getAppPaths();
const [command = "chat", provider = "instagram"] = process.argv.slice(2);
// KakaoTalk drives the desktop app through the macOS Accessibility API. The
// Windows build paints its chat list and message list with owner-drawn EVA
// controls that expose no UI Automation or MSAA text, so there is nothing to
// read there and the connector is not registered off macOS.
const kakaoSupported = process.platform === "darwin";
const browserProviders: Record<string, string> = {
  instagram: paths.browserProfileDir,
  discord: paths.discordProfileDir,
};

await removeLegacySnapshot(paths.dataDir);
const settingsStore = new SettingsStore(paths.settingsFile);
const settings = await settingsStore.load();
const cliLanguage = resolveLanguage(settings.language);
const cliText = cliLanguage === "ko" ? {
  unsupportedProvider: (value: string) => `지원하지 않는 provider입니다: ${value}`,
  login: "로그인용 Playwright Chromium을 엽니다. 로그인을 마친 뒤 Ctrl+C로 종료하세요.",
  chatBrowser: "chat browser: Playwright Chromium Headless (Dock 아이콘 없음)",
  logout: (value: string) => `${value} 전용 브라우저 프로필을 삭제했습니다.`,
  kakaoUnsupported: "KakaoTalk 커넥터는 macOS 전용이라 이 플랫폼에서는 비활성화됩니다.",
  loginError: (value: string) => `로그인 창에서 오류가 발생했습니다: ${value}`,
  help: `사용법:
  oh-my-dm                    TUI 실행
  oh-my-dm login <provider>   로그인 세션 생성 (instagram | discord)
  oh-my-dm logout <provider>  로그인 세션 삭제 (instagram | discord)
  oh-my-dm update             업데이트 방법 안내 (포크라 자동 업데이트 없음)
  oh-my-dm doctor             로컬 설정 확인

옵션:
  --headed                    디버깅용 브라우저 창 표시`,
} : {
  unsupportedProvider: (value: string) => `Unsupported provider: ${value}`,
  login: "Opening Playwright Chromium for login. When finished, press Ctrl+C to exit.",
  chatBrowser: "chat browser: Playwright Chromium Headless (no Dock icon)",
  logout: (value: string) => `Deleted the dedicated ${value} browser profile.`,
  kakaoUnsupported: "The KakaoTalk connector is macOS-only and is disabled on this platform.",
  loginError: (value: string) => `The login window reported an error: ${value}`,
  help: `Usage:
  oh-my-dm                    Start the TUI
  oh-my-dm login <provider>   Create a login session (instagram | discord)
  oh-my-dm logout <provider>  Delete a login session (instagram | discord)
  oh-my-dm update             How to update (a fork; no self-update)
  oh-my-dm doctor             Check the local setup

Options:
  --headed                    Show the browser window for debugging`,
};
let runtimeSettings = settings;
let settingsSaveQueue = Promise.resolve();
const saveSettings = (patch: Partial<typeof settings>): Promise<void> => {
  runtimeSettings = { ...runtimeSettings, ...patch };
  const nextSettings = runtimeSettings;
  settingsSaveQueue = settingsSaveQueue
    .catch(() => undefined)
    .then(() => settingsStore.save(nextSettings));
  return settingsSaveQueue;
};

if (!(provider in browserProviders) && command !== "chat") {
  console.error(cliText.unsupportedProvider(provider));
  process.exitCode = 1;
} else if (command === "chat") {
  // Upstream compares against `oh-my-dm` on npm and offers a one-key update.
  // This fork is not that package: accepting such a prompt would install
  // upstream over it and lose the Discord connector, and upstream's version
  // number says nothing about whether this fork has changed. No prompt.
  const availableUpdateVersion: string | undefined = undefined;
  const headless = !process.argv.includes("--headed");
  const instagram = new InstagramWebConnector({
    profileDir: paths.browserProfileDir,
    headless,
    cloneProfileWhenLocked: true,
  });
  const discord = new DiscordWebConnector({
    profileDir: paths.discordProfileDir,
    headless,
    cloneProfileWhenLocked: true,
  });
  const connector = new UnifiedChatConnector([
    { id: "instagram", label: "Instagram", connector: instagram },
    { id: "discord", label: "Discord", connector: discord },
    ...(kakaoSupported
      ? [{ id: "kakaotalk", label: "KakaoTalk", connector: new KakaoNativeConnector() }]
      : []),
  ]);
  const app = render(
    <App
      connector={connector}
      initialThemeId={settings.theme}
      initialModelId={settings.model}
      initialModelEffort={settings.modelEffort}
      initialLanguage={settings.language}
      availableUpdateVersion={availableUpdateVersion}
      onThemeChange={(theme) => saveSettings({ theme })}
      onModelChange={(model, modelEffort) => saveSettings({ model, modelEffort })}
      onLanguageChange={(language) => saveSettings({ language })}
      onUpdate={() => console.log(FORK_UPDATE_INSTRUCTIONS)}
    />,
    {
      maxFps: 120,
    },
  );
  // Ink's exit() resolves before React's async effect cleanup can finish.
  // Keep the CLI alive just long enough to close browser/native bridge handles,
  // otherwise they survive as orphans and continue driving KakaoTalk.
  await app.waitUntilExit();
  await connector.stop();
} else if (command === "login") {
  console.log(cliText.login);
  const profileDir = browserProviders[provider]!;
  const connector = provider === "discord"
    ? new DiscordWebConnector({ profileDir, headless: false })
    : new InstagramWebConnector({ profileDir, headless: false });
  // EventEmitter turns an 'error' with no listener into a process crash,
  // which would hide the real failure behind an unrelated stack trace.
  connector.on("error", (error: Error) => console.error(cliText.loginError(error.message)));
  await connector.start();
  await waitForSignal();
  await connector.stop();
} else if (command === "doctor") {
  const browser = resolveBrowserExecutable();
  console.log(`data: ${paths.dataDir}`);
  console.log(`instagram profile: ${paths.browserProfileDir}`);
  console.log(`discord profile: ${paths.discordProfileDir}`);
  console.log(`login browser: ${browser.label} (${browser.executablePath})`);
  console.log(cliText.chatBrowser);
  console.log(
    `runtime: Instagram web + Discord web${
      kakaoSupported ? " + KakaoTalk native bridge" : ""
    } / no message persistence`,
  );
  if (!kakaoSupported) console.log(cliText.kakaoUnsupported);
} else if (command === "update") {
  console.log(FORK_UPDATE_INSTRUCTIONS);
} else if (command === "logout") {
  await fs.rm(browserProviders[provider]!, { recursive: true, force: true });
  console.log(cliText.logout(provider));
} else {
  console.log(`oh-my-dm\n\n${cliText.help}`);
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

async function removeLegacySnapshot(dataDir: string): Promise<void> {
  try {
    await fs.unlink(`${dataDir}/snapshot.json`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
