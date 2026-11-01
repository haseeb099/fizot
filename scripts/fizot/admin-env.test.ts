import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { forbiddenAdminEnv, rejectFizotAdminEnv } from "../../server/fizot/admin-env.ts";

const root = join(import.meta.dirname, "..", "..");

it("rejects a hosted-admin variable at boot and accepts a boot without one", async () => {
  expect(forbiddenAdminEnv({})).toEqual([]);
  expect(() => rejectFizotAdminEnv({})).not.toThrow();
  expect(() => rejectFizotAdminEnv({ OMB_ADMIN_URL: "https://admin.example.test" })).toThrow(/OMB_ADMIN_URL/);
  expect(forbiddenAdminEnv({
    OMB_ADMIN_URL: "https://admin.example.test",
    OMB_ADMIN_WORKSPACE: "acme",
    OMB_ADMIN_MEMBERSHIP: "portal",
  })).toEqual(["OMB_ADMIN_URL", "OMB_ADMIN_WORKSPACE", "OMB_ADMIN_MEMBERSHIP"]);

  const home = mkdtempSync(join(tmpdir(), "fizot-boot-"));
  const output = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "server/index.ts"], {
      cwd: root,
      env: {
        ...process.env,
        OMB_ADMIN_URL: "https://admin.example.test",
        OMB_DATA_DIR: home,
        HOME: home,
        USERPROFILE: home,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "";
    child.stdout.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new Error("boot did not exit")); }, 90_000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, text }); });
  });
  expect(output.code).not.toBe(0);
  expect(output.text).toContain("Fizot refuses to boot while OMB_ADMIN_URL is set");
});
