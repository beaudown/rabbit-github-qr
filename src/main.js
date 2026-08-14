import QRCode from "qrcode";
import "./styles.css";
import { localStore } from "./lib/db.js";
import { GitHubClient, sha256Hex } from "./lib/github.js";
import {
  MAX_FILE_BYTES,
  buildFilePath,
  emptyIndex,
  formatBytes,
  githubFileUrl,
  makeFileId,
  mergeIndexes,
  normalizeRoot,
  rawGitHubUrl,
  reconcileIndex,
} from "./lib/model.js";

const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
const panels = [elements["home-panel"], elements["connection-panel"], elements["upload-panel"], elements["library-panel"]];

const state = {
  config: null,
  token: sessionStorage.getItem("rabbitGithubToken") || "",
  client: null,
  index: emptyIndex(),
  selectedFiles: [],
  findings: [],
  tree: [],
  deferredInstall: null,
};

function showPanel(panel) {
  for (const candidate of panels) candidate.hidden = candidate !== panel;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setStatus(element, message, kind = "") {
  element.textContent = message;
  element.className = `status ${kind}`.trim();
}

function repositoryLabel() {
  return state.config ? `${state.config.owner}/${state.config.repo} · ${state.config.branch}` : "Repository not connected";
}

function updateNetwork() {
  const online = navigator.onLine;
  elements["network-pill"].textContent = online ? "Online" : "Offline queue";
  elements["network-pill"].className = `pill ${online ? "online" : "offline"}`;
}

function derivePagesConfig() {
  if (!location.hostname.endsWith("github.io")) return null;
  const owner = location.hostname.split(".")[0];
  const repo = location.pathname.split("/").filter(Boolean)[0] || `${owner}.github.io`;
  return { owner, repo, branch: "main", root: "rabbit-files", autoRepair: true };
}

async function loadLocalState() {
  state.config = (await localStore.getState("config")) || derivePagesConfig();
  state.index = (await localStore.getState("index")) || emptyIndex(state.config || {});
  if (state.config) {
    elements.owner.value = state.config.owner || "";
    elements.repo.value = state.config.repo || "";
    elements.branch.value = state.config.branch || "main";
    elements["root-path"].value = state.config.root || "rabbit-files";
    elements["auto-repair"].checked = state.config.autoRepair !== false;
  }
  elements.token.value = state.token;
  elements["footer-repo"].textContent = repositoryLabel();
  renderLibrary();
}

function requireConnection(destination) {
  if (state.config && state.token) {
    state.client = new GitHubClient({ ...state.config, token: state.token });
    showPanel(destination);
    return true;
  }
  elements["connection-panel"].dataset.destination = destination.id;
  showPanel(elements["connection-panel"]);
  return false;
}

async function connect(event) {
  event.preventDefault();
  const config = {
    owner: elements.owner.value.trim(),
    repo: elements.repo.value.trim(),
    branch: elements.branch.value.trim() || "main",
    root: normalizeRoot(elements["root-path"].value),
    autoRepair: elements["auto-repair"].checked,
  };
  const token = elements.token.value.trim();
  setStatus(elements["connection-status"], "Verifying repository access…");
  try {
    const client = new GitHubClient({ ...config, token });
    const repository = await client.getRepository();
    state.config = config;
    state.token = token;
    state.client = client;
    sessionStorage.setItem("rabbitGithubToken", token);
    await localStore.setState("config", config);
    elements["footer-repo"].textContent = repositoryLabel();
    setStatus(
      elements["connection-status"],
      repository.private
        ? `Connected to ${repository.full_name}, but it is private. Uploads will work; unauthenticated Rabbit QR downloads will not. Use a public repository for direct device downloads.`
        : `Connected to public repository ${repository.full_name}; direct Rabbit QR downloads are available.`,
      repository.private ? "warning" : "success",
    );
    const destination = document.getElementById(elements["connection-panel"].dataset.destination || "library-panel");
    await syncRepository({ quiet: true });
    showPanel(destination);
  } catch (error) {
    setStatus(elements["connection-status"], `Connection failed: ${error.message}`, "error");
  }
}

function forgetToken() {
  state.token = "";
  state.client = null;
  elements.token.value = "";
  sessionStorage.removeItem("rabbitGithubToken");
  setStatus(elements["connection-status"], "Session token forgotten. Local index and repository settings were preserved.", "success");
}

function renderQueue() {
  elements["upload-queue"].replaceChildren();
  if (!state.selectedFiles.length) {
    elements["upload-queue"].className = "queue empty";
    elements["upload-queue"].textContent = "No files selected.";
    elements["upload-button"].disabled = true;
    return;
  }
  elements["upload-queue"].className = "queue";
  for (const file of state.selectedFiles) {
    const row = document.createElement("div");
    row.className = "queue-item";
    const name = document.createElement("strong");
    name.textContent = file.name;
    const size = document.createElement("span");
    size.textContent = formatBytes(file.size);
    if (file.size > MAX_FILE_BYTES) size.className = "danger-text";
    row.append(name, size);
    elements["upload-queue"].append(row);
  }
  elements["upload-button"].disabled = state.selectedFiles.some((file) => file.size > MAX_FILE_BYTES);
}

async function queueFile(file, tags, note) {
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} exceeds the 95 MiB GitHub upload limit.`);
  const now = new Date();
  const id = makeFileId(file.name, now);
  const path = buildFilePath(state.config.root, id, now);
  const sha256 = await sha256Hex(file);
  const entry = {
    id,
    name: file.name,
    path,
    size: file.size,
    mime: file.type || "application/octet-stream",
    sha256,
    tags,
    note,
    uploadedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    downloadUrl: rawGitHubUrl(state.config, path),
    githubUrl: githubFileUrl(state.config, path),
    syncState: "local-only",
    localState: "queued",
  };
  await localStore.putBlob({ id, blob: file, name: file.name, path, createdAt: now.toISOString() });
  state.index.files = [entry, ...state.index.files.filter((item) => item.id !== id)];
  await persistIndex();
  return entry;
}

async function uploadSelected() {
  if (!requireConnection(elements["upload-panel"])) return;
  const tags = elements["upload-tags"].value.split(",").map((tag) => tag.trim()).filter(Boolean);
  const note = elements["upload-note"].value.trim();
  elements["upload-button"].disabled = true;
  setStatus(elements["upload-status"], "Hashing and safely queueing files locally…");

  try {
    const entries = [];
    for (const file of state.selectedFiles) entries.push(await queueFile(file, tags, note));
    const { index: remoteIndex, sha: indexSha } = await state.client.loadIndex();
    const merged = mergeIndexes(state.index, remoteIndex);
    let completed = 0;
    for (const entry of entries) {
      setStatus(elements["upload-status"], `Uploading ${entry.name} (${completed + 1}/${entries.length})…`);
      const local = await localStore.getBlob(entry.id);
      await state.client.putContent(entry.path, await local.blob.arrayBuffer(), `Upload ${entry.name}`);
      entry.syncState = "indexed";
      entry.localState = "cached";
      const position = merged.files.findIndex((file) => file.id === entry.id);
      if (position >= 0) merged.files[position] = { ...merged.files[position], ...entry };
      else merged.files.unshift(entry);
      completed += 1;
    }
    await state.client.saveIndex(merged, indexSha);
    state.index = merged;
    await persistIndex();
    state.selectedFiles = [];
    elements["file-input"].value = "";
    renderQueue();
    renderLibrary();
    setStatus(elements["upload-status"], `${completed} file${completed === 1 ? "" : "s"} uploaded, indexed, and ready as QR codes.`, "success");
    showPanel(elements["library-panel"]);
    await syncRepository({ quiet: true });
  } catch (error) {
    setStatus(elements["upload-status"], `Upload stopped safely: ${error.message}. Queued local files remain recoverable.`, "error");
  } finally {
    elements["upload-button"].disabled = false;
  }
}

async function persistIndex() {
  state.index.updatedAt = new Date().toISOString();
  await localStore.setState("index", state.index);
}

async function pushLocalOnly(finding, remoteIndex, indexSha) {
  const local = await localStore.getBlob(finding.id);
  if (!local?.blob) throw new Error(`Local bytes are unavailable for ${finding.file.name}.`);
  await state.client.putContent(finding.path, await local.blob.arrayBuffer(), `Recover queued upload ${finding.file.name}`);
  const file = { ...finding.file, syncState: "indexed", localState: "cached", updatedAt: new Date().toISOString() };
  remoteIndex.files = [file, ...remoteIndex.files.filter((item) => item.id !== file.id)];
  await state.client.saveIndex(remoteIndex, indexSha);
  return file;
}

async function syncRepository({ quiet = false } = {}) {
  if (!state.config || !state.token) {
    if (!quiet) requireConnection(elements["library-panel"]);
    return;
  }
  state.client ||= new GitHubClient({ ...state.config, token: state.token });
  if (!quiet) setStatus(elements["library-status"], "Reading GitHub index and repository tree…");
  elements["sync-button"].disabled = true;
  try {
    let { index: remoteIndex, sha: indexSha } = await state.client.loadIndex();
    state.index = mergeIndexes(state.index, remoteIndex);
    const blobs = await localStore.getAllBlobs();
    const blobIds = new Set(blobs.map((record) => record.id));
    let tree = await state.client.listLibraryTree();
    let findings = reconcileIndex(state.index, tree.map((item) => item.path), blobIds);

    if (state.config.autoRepair) {
      for (const finding of findings.filter((item) => item.kind === "local-only")) {
        const repaired = await pushLocalOnly(finding, remoteIndex, indexSha);
        const refreshed = await state.client.loadIndex();
        remoteIndex = refreshed.index;
        indexSha = refreshed.sha;
        state.index.files = state.index.files.map((file) => file.id === repaired.id ? repaired : file);
      }
      tree = await state.client.listLibraryTree();
      findings = reconcileIndex(state.index, tree.map((item) => item.path), blobIds);
    }

    state.tree = tree;
    state.findings = findings;
    await loadAuditBanner();
    await persistIndex();
    renderLibrary();
    renderFindings();
    if (!quiet) setStatus(elements["library-status"], `Reconciled ${state.index.files.length} indexed file${state.index.files.length === 1 ? "" : "s"}; ${findings.length} item${findings.length === 1 ? "" : "s"} need attention.`, findings.length ? "warning" : "success");
  } catch (error) {
    setStatus(elements["library-status"], `Reconciliation failed: ${error.message}`, "error");
  } finally {
    elements["sync-button"].disabled = false;
  }
}

async function loadAuditBanner() {
  const content = await state.client.loadAuditReport();
  if (!content?.content) {
    elements["audit-banner"].hidden = true;
    return;
  }
  const report = JSON.parse(GitHubClient.decodeTextContent(content.content));
  elements["audit-banner"].hidden = false;
  elements["audit-banner"].className = `audit-banner ${report.status === "ok" ? "ok" : "warning"}`;
  elements["audit-banner"].textContent = `Last scheduled audit: ${new Date(report.generatedAt).toLocaleString()} · ${report.status === "ok" ? "all indexed files verified" : `${report.summary.totalIssues} issue(s) reported`}`;
}

function createButton(label, className, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `button ${className}`;
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function renderFindings() {
  elements["reconcile-list"].replaceChildren();
  elements["reconcile-panel"].hidden = state.findings.length === 0;
  for (const finding of state.findings) {
    const item = document.createElement("article");
    item.className = "finding";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = finding.kind === "remote-only" ? "On GitHub, not indexed" : finding.kind === "local-only" ? "Queued locally, not on GitHub" : "Indexed file missing from GitHub";
    const path = document.createElement("code");
    path.textContent = finding.path;
    copy.append(title, path);
    const actions = document.createElement("div");
    actions.className = "action-row compact-actions";
    if (finding.kind === "remote-only") {
      actions.append(
        createButton("Add to index", "primary", () => adoptRemote(finding)),
        createButton("Leave + flag", "quiet", () => ignoreRemote(finding)),
        createButton("Archive", "quiet", () => archiveRemote(finding)),
        createButton("Delete", "danger", () => deleteRemote(finding)),
      );
    } else if (finding.kind === "local-only") {
      actions.append(createButton("Push now", "primary", () => repairLocal(finding)));
    } else {
      actions.append(createButton("Remove broken index entry", "danger", () => removeIndexEntry(finding)));
    }
    item.append(copy, actions);
    elements["reconcile-list"].append(item);
  }
}

async function withRemoteIndex(action) {
  const { index, sha } = await state.client.loadIndex();
  await action(index, sha);
  await syncRepository();
}

async function ignoreRemote(finding) {
  await withRemoteIndex(async (index, sha) => {
    index.ignoredRemotePaths = [...(index.ignoredRemotePaths || []).filter((item) => item.path !== finding.path), { path: finding.path, addedAt: new Date().toISOString(), reason: "User chose Leave + flag" }];
    await state.client.saveIndex(index, sha);
  });
}

async function adoptRemote(finding) {
  setStatus(elements["library-status"], `Hashing ${finding.path} before adding it to the index…`);
  await withRemoteIndex(async (index, sha) => {
    const bytes = await state.client.getRawContent(finding.path);
    const blob = new Blob([bytes]);
    const name = finding.path.split("/").pop();
    const id = makeFileId(name);
    const entry = {
      id,
      name,
      path: finding.path,
      size: bytes.byteLength,
      mime: "application/octet-stream",
      sha256: await sha256Hex(blob),
      tags: ["adopted"],
      note: "Adopted from a GitHub-only file during reconciliation.",
      uploadedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      downloadUrl: rawGitHubUrl(state.config, finding.path),
      githubUrl: githubFileUrl(state.config, finding.path),
      syncState: "indexed",
      localState: "metadata-only",
    };
    index.files.unshift(entry);
    await state.client.saveIndex(index, sha);
  });
}

function confirmAction(title, message, label = "Confirm") {
  elements["confirm-title"].textContent = title;
  elements["confirm-message"].textContent = message;
  elements["confirm-accept"].textContent = label;
  elements["confirm-dialog"].showModal();
  return new Promise((resolve) => {
    elements["confirm-dialog"].addEventListener("close", () => resolve(elements["confirm-dialog"].returnValue === "confirm"), { once: true });
  });
}

async function archiveRemote(finding) {
  if (!await confirmAction("Archive GitHub file?", `${finding.path} will be copied to the dated archive folder, then removed from its current path.`, "Archive")) return;
  const date = new Date().toISOString().slice(0, 10);
  const target = `${state.config.root}/archive/${date}/${finding.path.split("/").pop()}`;
  await state.client.moveContent(finding.path, target);
  await withRemoteIndex(async (index, sha) => {
    index.archivedPaths = [...(index.archivedPaths || []), { from: finding.path, to: target, archivedAt: new Date().toISOString() }];
    await state.client.saveIndex(index, sha);
  });
}

async function deleteRemote(finding) {
  if (!await confirmAction("Delete GitHub file?", `${finding.path} will be deleted from the repository. Git history may still allow recovery.`, "Delete from GitHub")) return;
  await state.client.deleteContent(finding.path, `Delete unindexed Rabbit file ${finding.path}`);
  await syncRepository();
}

async function repairLocal(finding) {
  const loaded = await state.client.loadIndex();
  await pushLocalOnly(finding, loaded.index, loaded.sha);
  await syncRepository();
}

async function removeIndexEntry(finding) {
  if (!await confirmAction("Remove broken index entry?", `${finding.path} is missing from GitHub and has no recoverable local bytes. The index record will be removed.`, "Remove entry")) return;
  await withRemoteIndex(async (index, sha) => {
    index.files = index.files.filter((file) => file.id !== finding.id);
    await state.client.saveIndex(index, sha);
  });
}

function renderLibrary() {
  const query = elements["search-input"]?.value.trim().toLowerCase() || "";
  const files = state.index.files.filter((file) => [file.name, file.path, file.note, ...(file.tags || [])].join(" ").toLowerCase().includes(query));
  elements["file-grid"].replaceChildren();
  elements["library-empty"].hidden = files.length > 0;
  const total = state.index.files.reduce((sum, file) => sum + (file.size || 0), 0);
  elements["summary-strip"].textContent = `${state.index.files.length} indexed file${state.index.files.length === 1 ? "" : "s"} · ${formatBytes(total)} · ${state.findings.length} reconciliation finding${state.findings.length === 1 ? "" : "s"}`;

  for (const file of files) {
    const card = document.createElement("article");
    card.className = "file-card";
    const qr = document.createElement("canvas");
    qr.className = "qr";
    qr.setAttribute("aria-label", `QR code for ${file.name}`);
    QRCode.toCanvas(qr, file.downloadUrl, { width: 176, margin: 1, errorCorrectionLevel: "M", color: { dark: "#11130f", light: "#f5f4ec" } }).catch(() => {});
    const body = document.createElement("div");
    body.className = "file-body";
    const badge = document.createElement("span");
    badge.className = `pill ${file.syncState === "indexed" ? "online" : "offline"}`;
    badge.textContent = file.syncState === "indexed" ? "Indexed" : "Local only";
    const title = document.createElement("h3");
    title.textContent = file.name;
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = `${formatBytes(file.size)} · ${new Date(file.uploadedAt).toLocaleString()}`;
    const path = document.createElement("code");
    path.textContent = file.path;
    const note = document.createElement("p");
    note.textContent = file.note || "No note.";
    const tagRow = document.createElement("div");
    tagRow.className = "tags";
    for (const tag of file.tags || []) {
      const item = document.createElement("span");
      item.textContent = tag;
      tagRow.append(item);
    }
    const actions = document.createElement("div");
    actions.className = "action-row card-actions";
    const copy = createButton("Copy URL", "primary", async () => {
      await navigator.clipboard.writeText(file.downloadUrl);
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy URL"; }, 1400);
    });
    const download = document.createElement("a");
    download.className = "button quiet";
    download.href = file.downloadUrl;
    download.target = "_blank";
    download.rel = "noopener";
    download.textContent = "Download";
    actions.append(copy, download);
    body.append(badge, title, meta, path, note, tagRow, actions);
    card.append(qr, body);
    elements["file-grid"].append(card);
  }
}

function exportIndex() {
  const blob = new Blob([`${JSON.stringify(state.index, null, 2)}\n`], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `rabbit-github-index-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function bindEvents() {
  elements["choose-upload"].addEventListener("click", () => showPanel(elements["upload-panel"]));
  elements["choose-library"].addEventListener("click", () => {
    showPanel(elements["library-panel"]);
    if (state.config && state.token) syncRepository({ quiet: true });
    else setStatus(elements["library-status"], "Showing the local index. Connect GitHub to reconcile remote files.", "warning");
  });
  document.querySelector(".brand").addEventListener("click", (event) => {
    event.preventDefault();
    showPanel(elements["home-panel"]);
  });
  elements["settings-button"].addEventListener("click", () => showPanel(elements["connection-panel"]));
  elements["connection-form"].addEventListener("submit", connect);
  elements["disconnect-button"].addEventListener("click", forgetToken);
  for (const button of document.querySelectorAll(".back-home")) button.addEventListener("click", () => showPanel(elements["home-panel"]));
  elements["file-input"].addEventListener("change", () => {
    state.selectedFiles = [...elements["file-input"].files];
    renderQueue();
  });
  elements["clear-selection"].addEventListener("click", () => {
    state.selectedFiles = [];
    elements["file-input"].value = "";
    renderQueue();
  });
  elements["upload-button"].addEventListener("click", uploadSelected);
  elements["sync-button"].addEventListener("click", () => syncRepository());
  elements["search-input"].addEventListener("input", renderLibrary);
  elements["export-button"].addEventListener("click", exportIndex);
  window.addEventListener("online", updateNetwork);
  window.addEventListener("offline", updateNetwork);
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredInstall = event;
    elements["install-button"].hidden = false;
  });
  elements["install-button"].addEventListener("click", async () => {
    if (!state.deferredInstall) return;
    await state.deferredInstall.prompt();
    state.deferredInstall = null;
    elements["install-button"].hidden = true;
  });
}

async function start() {
  updateNetwork();
  bindEvents();
  renderQueue();
  await loadLocalState();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
  if (state.config && state.token && navigator.onLine) {
    state.client = new GitHubClient({ ...state.config, token: state.token });
    syncRepository({ quiet: true });
  }
}

start();
