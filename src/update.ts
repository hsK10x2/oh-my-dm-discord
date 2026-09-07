

const LATEST_PACKAGE_URL = "https://registry.npmjs.org/oh-my-dm/latest";

export function isNewerVersion(current: string, candidate: string): boolean {
  const left = parseVersion(current);
  const right = parseVersion(candidate);
  if (!left || !right) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (right[index]! !== left[index]!) return right[index]! > left[index]!;
  }
  return false;
}

export async function checkForUpdate(
  currentVersion: string,
  fetchLatest: typeof fetch = fetch,
  timeoutMs = 1_200,
): Promise<string | undefined> {
  try {
    const response = await fetchLatest(LATEST_PACKAGE_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as { version?: unknown };
    const candidate = typeof payload.version === "string" ? payload.version : undefined;
    return candidate && isNewerVersion(currentVersion, candidate) ? candidate : undefined;
  } catch {
    // Update checks must never delay or prevent the messenger from starting.
    return undefined;
  }
}

export const FORK_UPDATE_INSTRUCTIONS = [
  "이 빌드는 포크라 npm에 없습니다. 자기 자신을 업데이트할 수 없습니다.",
  "This build is a fork and is not on npm, so it cannot update itself.",
  "",
  "업데이트하려면 / To update, in your checkout:",
  "  git pull && npm install && npm run build",
].join("\n");

/**
 * Upstream installs `oh-my-dm@latest` from npm here. In this fork that would
 * replace the running build with upstream and silently drop the Discord
 * connector, so the npm path is removed rather than left as a footgun.
 */
export function installLatestVersion(_options: { silent?: boolean } = {}): Promise<void> {
  return Promise.reject(new Error(FORK_UPDATE_INSTRUCTIONS));
}

function parseVersion(value: string): [number, number, number] | undefined {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
