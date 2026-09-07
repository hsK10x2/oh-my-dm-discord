import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AppPaths {
  dataDir: string;
  /** Instagram browser profile. Named without a provider for backwards compatibility. */
  browserProfileDir: string;
  discordProfileDir: string;
  settingsFile: string;
}

export function getAppPaths(env: NodeJS.ProcessEnv = process.env): AppPaths {
  const newDefault = path.join(os.homedir(), ".oh-my-dm");
  const legacyDefault = path.join(os.homedir(), ".oh-my-chat");
  const configuredDataDir = env.OH_MY_DM_DATA ?? env.OH_MY_CHAT_DATA;
  const dataDir = configuredDataDir
    ? path.resolve(configuredDataDir)
    : existsSync(newDefault) || !existsSync(legacyDefault)
      ? newDefault
      : legacyDefault;

  return {
    dataDir,
    browserProfileDir: path.join(dataDir, "browser", "instagram"),
    discordProfileDir: path.join(dataDir, "browser", "discord"),
    settingsFile: path.join(dataDir, "settings.json"),
  };
}
