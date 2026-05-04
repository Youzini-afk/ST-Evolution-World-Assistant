import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ALLOWED_BUMPS = new Set(["major", "minor", "patch"]);

/**
 * Bump a semver-style version string by the requested segment.
 * 不再强制每段 < 10 — semver 段本来就没有上限（如 0.10.0、1.20.5）。
 * 仅按 bump 类型对单个段递增，并把更细粒度段重置为 0。
 */
function incrementVersion(version, bumpType = "patch") {
  if (typeof version !== "string" || !version.trim()) {
    throw new Error("version is missing.");
  }
  if (!ALLOWED_BUMPS.has(bumpType)) {
    throw new Error(`Unsupported bump type: ${bumpType}`);
  }

  const segments = version.split(".").map(segment => {
    if (!/^\d+$/.test(segment)) {
      throw new Error(`Unsupported version segment: ${segment}`);
    }
    return Number(segment);
  });

  // 把版本归一到 major.minor.patch（缺位补 0，多位忽略）
  const [major = 0, minor = 0, patch = 0] = segments;

  if (bumpType === "major") {
    return `${major + 1}.0.0`;
  }
  if (bumpType === "minor") {
    return `${major}.${minor + 1}.0`;
  }
  return `${major}.${minor}.${patch + 1}`;
}

function parseBumpType(argv) {
  if (argv.includes("--major")) return "major";
  if (argv.includes("--minor")) return "minor";
  return "patch";
}

async function bumpJsonFile(filePath, bumpType, { dryRun, syncTo }) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const data = JSON.parse(raw);
  const current = data?.version;
  const next = syncTo ?? incrementVersion(current, bumpType);

  if (dryRun) {
    console.log(`${path.basename(filePath)}: ${current} -> ${next}`);
    return next;
  }

  data.version = next;

  // package-lock.json 还在 packages.""."version" 里冗余存了一份版本号
  if (data.packages && data.packages[""] && typeof data.packages[""].version === "string") {
    data.packages[""].version = next;
  }

  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`Updated ${path.basename(filePath)} version: ${current} -> ${next}`);
  return next;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const bumpType = parseBumpType(process.argv);

  const cwd = process.cwd();
  const manifestPath = path.resolve(cwd, process.env.MANIFEST_PATH || "manifest.json");
  const packagePath = path.resolve(cwd, "package.json");
  const packageLockPath = path.resolve(cwd, "package-lock.json");

  // manifest.json 是版本号的唯一权威来源（ST 扩展通过它判断版本）
  const nextVersion = await bumpJsonFile(manifestPath, bumpType, { dryRun });
  if (!nextVersion) {
    throw new Error(`manifest.json not found at ${manifestPath}`);
  }

  // package.json / package-lock.json 跟随 manifest 版本，避免三处不一致
  await bumpJsonFile(packagePath, bumpType, { dryRun, syncTo: nextVersion });
  await bumpJsonFile(packageLockPath, bumpType, { dryRun, syncTo: nextVersion });
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
