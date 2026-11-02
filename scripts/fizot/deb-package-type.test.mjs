import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeDebPackageType } from "../deb-package-type.mjs";
import { appUpdateNamesUpstreamOwner } from "../verify-linux-package.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("deb package-type marker", () => {
  it("writes deb into the package resources and does not write an update file", () => {
    const extracted = mkdtempSync(path.join(tmpdir(), "fizot-deb-marker-"));
    temporaryDirectories.push(extracted);
    const resources = path.join(extracted, "opt", "Fizot", "resources");
    mkdirSync(resources, { recursive: true });

    expect(writeDebPackageType(extracted)).toBe(path.join(resources, "package-type"));
    expect(readFileSync(path.join(resources, "package-type"), "utf8")).toBe("deb");
    expect(existsSync(path.join(resources, "app-update.yml"))).toBe(false);
  });

  it("rejects an app-update.yml that names the upstream owner", () => {
    expect(appUpdateNamesUpstreamOwner("owner: milind-soni\nprovider: github\n")).toBe(true);
    expect(appUpdateNamesUpstreamOwner("provider: generic\n")).toBe(false);
    expect(appUpdateNamesUpstreamOwner("")).toBe(false);
  });
});
