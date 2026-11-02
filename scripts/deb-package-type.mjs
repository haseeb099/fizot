import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PRODUCT_DIR = "Fizot";

export function writeDebPackageType(extractedRoot) {
  const resources = path.join(extractedRoot, "opt", PRODUCT_DIR, "resources");
  if (!statSync(resources, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`deb resources directory is missing: ${resources}`);
  }
  const marker = path.join(resources, "package-type");
  writeFileSync(marker, "deb");
  chmodSync(marker, 0o644);
  return marker;
}

export function stampDebPackageType(debPath) {
  const scratch = mkdtempSync(path.join(tmpdir(), "fizot-deb-marker-"));
  const rebuilt = `${debPath}.stamped`;
  try {
    execFileSync("dpkg-deb", ["--raw-extract", debPath, scratch], { stdio: "pipe" });
    writeDebPackageType(scratch);
    execFileSync("dpkg-deb", ["--build", "--root-owner-group", scratch, rebuilt], { stdio: "pipe" });
    renameSync(rebuilt, debPath);
  } catch (error) {
    const detail = error?.stderr?.toString?.() ?? error?.message ?? String(error);
    throw new Error(`could not stamp package-type into ${debPath}: ${detail}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(rebuilt, { force: true });
  }
}

export async function afterAllArtifactBuild(result) {
  for (const file of result.artifactPaths ?? []) {
    if (file.endsWith(".deb")) stampDebPackageType(file);
  }
}
