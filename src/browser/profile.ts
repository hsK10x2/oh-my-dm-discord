import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Chromium refuses to reuse a persistent profile that another process already
 * holds. `oh-my-dm login <provider>` and the running TUI both point at the
 * same directory, so this is an ordinary situation rather than a failure.
 */
export function isProfileLockError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ProcessSingleton|profile (?:appears to be|is) in use|user data directory is already in use/i.test(message);
}

export async function cloneBrowserProfile(
  sourceProfileDir: string,
  temporaryRoot = os.tmpdir(),
  prefix = "oh-my-dm-profile-",
): Promise<{ profileDir: string; cleanupDir: string }> {
  const cleanupDir = await fs.mkdtemp(path.join(temporaryRoot, prefix));
  const profileDir = path.join(cleanupDir, "profile");
  try {
    await fs.cp(sourceProfileDir, profileDir, {
      recursive: true,
      filter: (source) => !path.basename(source).startsWith("Singleton"),
    });
    return { profileDir, cleanupDir };
  } catch (error) {
    await fs.rm(cleanupDir, { recursive: true, force: true });
    throw error;
  }
}
