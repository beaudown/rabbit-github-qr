export const INDEX_SCHEMA_VERSION = 1;
export const MAX_FILE_BYTES = 95 * 1024 * 1024;

export function emptyIndex(repository = {}) {
  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    updatedAt: new Date(0).toISOString(),
    repository: {
      owner: repository.owner || "",
      repo: repository.repo || "",
      branch: repository.branch || "main",
      root: repository.root || "rabbit-files",
    },
    files: [],
    ignoredRemotePaths: [],
    archivedPaths: [],
  };
}

export function normalizeRoot(value) {
  return String(value || "rabbit-files")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/") || "rabbit-files";
}

export function safeFilename(value) {
  const input = String(value || "download").normalize("NFKD");
  const dot = input.lastIndexOf(".");
  const extension = dot > 0 ? input.slice(dot).toLowerCase().replace(/[^a-z0-9.]/g, "") : "";
  const stem = (dot > 0 ? input.slice(0, dot) : input)
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "download";
  return `${stem}${extension}`;
}

export function makeFileId(name, now = new Date(), random = crypto.randomUUID()) {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${stamp}-${random.slice(0, 8)}-${safeFilename(name)}`;
}

export function buildFilePath(root, id, now = new Date()) {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${normalizeRoot(root)}/files/${year}/${month}/${id}`;
}

export function rawGitHubUrl(config, path) {
  const parts = path.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/${encodeURIComponent(config.branch)}/${parts}`;
}

export function githubFileUrl(config, path) {
  const parts = path.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/blob/${encodeURIComponent(config.branch)}/${parts}`;
}

export function mergeIndexes(localIndex, remoteIndex) {
  const base = remoteIndex || localIndex || emptyIndex();
  const localFiles = new Map((localIndex?.files || []).map((file) => [file.id, file]));
  const remoteFiles = new Map((remoteIndex?.files || []).map((file) => [file.id, file]));
  const files = [];

  for (const id of new Set([...localFiles.keys(), ...remoteFiles.keys()])) {
    const local = localFiles.get(id);
    const remote = remoteFiles.get(id);
    files.push({
      ...(local || {}),
      ...(remote || {}),
      localState: local?.localState || (remote ? "metadata-only" : "local-only"),
      syncState: remote ? "indexed" : "local-only",
    });
  }

  return {
    ...emptyIndex(base.repository),
    ...base,
    files: files.sort((a, b) => String(b.uploadedAt || "").localeCompare(String(a.uploadedAt || ""))),
    ignoredRemotePaths: remoteIndex?.ignoredRemotePaths || localIndex?.ignoredRemotePaths || [],
    archivedPaths: remoteIndex?.archivedPaths || localIndex?.archivedPaths || [],
  };
}

export function reconcileIndex(index, remoteTreePaths, localBlobIds = new Set()) {
  const tree = new Set(remoteTreePaths);
  const indexedPaths = new Set(index.files.map((file) => file.path));
  const ignored = new Set((index.ignoredRemotePaths || []).map((item) => item.path));
  const findings = [];

  for (const file of index.files) {
    if (!tree.has(file.path)) {
      findings.push({
        kind: localBlobIds.has(file.id) ? "local-only" : "missing-remote",
        id: file.id,
        path: file.path,
        file,
      });
    }
  }

  for (const path of tree) {
    if (!indexedPaths.has(path) && !ignored.has(path)) {
      findings.push({ kind: "remote-only", path });
    }
  }

  return findings;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  const order = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** order).toFixed(order ? 1 : 0)} ${units[order]}`;
}
