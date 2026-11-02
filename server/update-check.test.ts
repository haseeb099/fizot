import { join, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createUpdateChecker, installKind, isNewerVersion } from "./update-check.ts";

const LOOKUP = "https://example.invalid/releases/latest";
const release = (tag: string) =>
  ({ ok: true, status: 200, json: async () => ({ tag_name: tag, html_url: `https://example.invalid/releases/tag/${tag}` }) }) as Response;

describe("server update check", () => {
  it("tells how this server was installed", () => {
    const none = () => false;
    const root = ["", "srv", "Fizot", "server"].join(sep);
    expect(installKind({ desktopManaged: true, managed: false, serverRoot: root, exists: () => true })).toBe("desktop");
    expect(installKind({ desktopManaged: false, managed: true, serverRoot: root, exists: () => true })).toBe("managed");
    expect(installKind({ desktopManaged: false, managed: false, serverRoot: root, exists: (path) => path === "/.dockerenv" })).toBe("docker");
    expect(installKind({ desktopManaged: false, managed: false, serverRoot: root, exists: (path) => path === "/run/.containerenv" })).toBe("podman");
    expect(installKind({
      desktopManaged: false, managed: false, exists: none,
      serverRoot: ["", "usr", "lib", "node_modules", "openmausbot", "dist-server"].join(sep),
    })).toBe("npm");
    expect(installKind({ desktopManaged: false, managed: false, serverRoot: root, exists: (path) => path === join(root, "..", ".git") })).toBe("git");
    expect(installKind({ desktopManaged: false, managed: false, serverRoot: root, exists: none })).toBe("unknown");
  });

  it("compares release versions numerically and never reports a malformed one", () => {
    expect(isNewerVersion("v0.1.93", "0.1.92")).toBe(true);
    expect(isNewerVersion("0.1.10", "0.1.9")).toBe(true);
    expect(isNewerVersion("v0.2.0", "0.1.99")).toBe(true);
    expect(isNewerVersion("v0.1.92", "0.1.92")).toBe(false);
    expect(isNewerVersion("v0.1.91", "0.1.92")).toBe(false);
    expect(isNewerVersion("nightly", "0.1.92")).toBe(false);
    expect(isNewerVersion("v0.1.93", "unknown")).toBe(false);
    expect(isNewerVersion("v0.1.93", "0.1.93-rc.1")).toBe(true);
    expect(isNewerVersion("v0.1.93-rc.2", "0.1.93-rc.1")).toBe(true);
    expect(isNewerVersion("v0.1.93-rc.10", "0.1.93-rc.9")).toBe(true);
    expect(isNewerVersion("v0.1.93-rc.1", "0.1.93")).toBe(false);
    expect(isNewerVersion("v0.1.93-rc.1", "0.1.93-rc.1")).toBe(false);
    expect(isNewerVersion("v0.1.93-rc.1.1", "0.1.93-rc.1")).toBe(true);
  });

  it("reports a newer release with the update command for this install", async () => {
    const fetch = vi.fn(async () => release("v0.1.93"));
    const check = createUpdateChecker({ current: "0.1.92", install: "docker", fetch, lookupUrl: LOOKUP });
    expect(await check()).toEqual({
      current: "0.1.92",
      install: "docker",
      latest: "0.1.93",
      available: true,
      releaseUrl: "https://example.invalid/releases/tag/v0.1.93",
      command: "docker compose pull omb && docker compose up -d",
      restart: false,
    });
    expect(fetch).toHaveBeenCalledWith(LOOKUP, expect.anything());
  });

  it("says up to date, and asks GitHub at most once an hour", async () => {
    let now = 0;
    const fetch = vi.fn(async () => release("v0.1.92"));
    const check = createUpdateChecker({ current: "0.1.92", install: "npm", fetch, now: () => now, lookupUrl: LOOKUP });
    expect(await check()).toMatchObject({ available: false, latest: "0.1.92", command: "npm install -g openmausbot@latest", restart: true });
    now = 59 * 60_000;
    await check();
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 61 * 60_000;
    await check();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not call out when the Fizot update URL is empty", async () => {
    const fetch = vi.fn();
    expect(await createUpdateChecker({ current: "0.1.92", install: "docker", fetch })()).toMatchObject({ available: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not look anything up for a desktop or hosted server", async () => {
    const fetch = vi.fn();
    for (const install of ["desktop", "managed"] as const) {
      expect(await createUpdateChecker({ current: "0.1.92", install, fetch })()).toEqual({ current: "0.1.92", install, available: false });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails clearly when GitHub cannot be reached, and tries again next time", async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }) as Response);
    const check = createUpdateChecker({ current: "0.1.92", install: "git", fetch, lookupUrl: LOOKUP });
    await expect(check()).rejects.toThrow("GitHub answered 403");
    fetch.mockImplementation(async () => release("v0.1.93"));
    expect(await check()).toMatchObject({ available: true, command: "git pull && pnpm install", restart: true });
  });
});
