import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const libraryRoot = join(projectRoot, "rabbit-files");
const filesRoot = join(libraryRoot, "files");
const indexPath = join(libraryRoot, "index.json");
const reportPath = join(libraryRoot, "audit-report.json");

async function walk(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const output = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) output.push(...await walk(path));
      else if (entry.isFile()) output.push(path);
    }
    return output;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function repositoryPath(path) {
  return relative(projectRoot, path).split(sep).join("/");
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

const index = JSON.parse(await readFile(indexPath, "utf8"));
const repositoryFiles = await walk(filesRoot);
const byPath = new Map(repositoryFiles.map((path) => [repositoryPath(path), path]));
const indexedPaths = new Set(index.files.map((file) => file.path));
const ignored = new Set((index.ignoredRemotePaths || []).map((item) => item.path));
const issues = [];

for (const file of index.files) {
  const diskPath = byPath.get(file.path);
  if (!diskPath) {
    issues.push({ kind: "missing-indexed-file", path: file.path, id: file.id });
    continue;
  }
  const metadata = await stat(diskPath);
  if (metadata.size !== file.size) issues.push({ kind: "size-mismatch", path: file.path, expected: file.size, actual: metadata.size });
  const hash = await sha256(diskPath);
  if (hash !== file.sha256) issues.push({ kind: "sha256-mismatch", path: file.path, expected: file.sha256, actual: hash });
}

for (const [path] of byPath) {
  if (!indexedPaths.has(path) && !ignored.has(path)) issues.push({ kind: "unindexed-repository-file", path });
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  status: issues.length ? "issues" : "ok",
  summary: {
    indexedFiles: index.files.length,
    repositoryFiles: repositoryFiles.length,
    totalIssues: issues.length,
  },
  issues,
};

await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Rabbit index audit: ${report.status}; ${issues.length} issue(s).`);
