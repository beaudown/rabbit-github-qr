import { emptyIndex, normalizeRoot } from "./model.js";

const API_VERSION = "2026-03-10";

function encodePath(path) {
  return String(path).split("/").map(encodeURIComponent).join("/");
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function textToBase64(text) {
  return arrayBufferToBase64(new TextEncoder().encode(text).buffer);
}

function base64ToText(content) {
  const binary = atob(content.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export class GitHubClient {
  constructor(config) {
    this.config = { ...config, root: normalizeRoot(config.root) };
  }

  async request(endpoint, options = {}) {
    const response = await fetch(`https://api.github.com${endpoint}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.config.token}`,
        "X-GitHub-Api-Version": API_VERSION,
        ...(options.headers || {}),
      },
    });

    if (response.status === 404 && options.allow404) return null;
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`;
      try {
        const body = await response.json();
        if (body.message) detail = `${detail}: ${body.message}`;
      } catch {
        // Keep the HTTP status when GitHub does not return JSON.
      }
      throw new Error(detail);
    }
    if (options.raw) return response.arrayBuffer();
    if (response.status === 204) return null;
    return response.json();
  }

  repoEndpoint(suffix = "") {
    const { owner, repo } = this.config;
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
  }

  getRepository() {
    return this.request(this.repoEndpoint());
  }

  getContent(path) {
    return this.request(this.repoEndpoint(`/contents/${encodePath(path)}?ref=${encodeURIComponent(this.config.branch)}`), { allow404: true });
  }

  getRawContent(path) {
    return this.request(this.repoEndpoint(`/contents/${encodePath(path)}?ref=${encodeURIComponent(this.config.branch)}`), {
      raw: true,
      headers: { Accept: "application/vnd.github.raw+json" },
    });
  }

  async putContent(path, content, message, existingSha = undefined) {
    const base64 = typeof content === "string" ? textToBase64(content) : arrayBufferToBase64(content);
    return this.request(this.repoEndpoint(`/contents/${encodePath(path)}`), {
      method: "PUT",
      body: JSON.stringify({
        message,
        content: base64,
        branch: this.config.branch,
        ...(existingSha ? { sha: existingSha } : {}),
      }),
    });
  }

  async deleteContent(path, message) {
    const current = await this.getContent(path);
    if (!current?.sha) throw new Error(`GitHub file not found: ${path}`);
    return this.request(this.repoEndpoint(`/contents/${encodePath(path)}`), {
      method: "DELETE",
      body: JSON.stringify({ message, sha: current.sha, branch: this.config.branch }),
    });
  }

  async moveContent(fromPath, toPath) {
    const bytes = await this.getRawContent(fromPath);
    const existing = await this.getContent(toPath);
    await this.putContent(toPath, bytes, `Archive ${fromPath}`, existing?.sha);
    await this.deleteContent(fromPath, `Remove archived source ${fromPath}`);
  }

  async loadIndex() {
    const path = `${this.config.root}/index.json`;
    const content = await this.getContent(path);
    if (!content) return { index: emptyIndex(this.config), sha: null };
    if (!content.content) throw new Error("The GitHub index is unexpectedly larger than 1 MiB.");
    const index = JSON.parse(base64ToText(content.content));
    return { index, sha: content.sha };
  }

  saveIndex(index, sha = undefined) {
    const path = `${this.config.root}/index.json`;
    const files = (index.files || []).map((file) => {
      const { localState: _localState, syncState: _syncState, ...portable } = file;
      return portable;
    });
    const next = {
      ...index,
      files,
      updatedAt: new Date().toISOString(),
      repository: {
        owner: this.config.owner,
        repo: this.config.repo,
        branch: this.config.branch,
        root: this.config.root,
      },
    };
    return this.putContent(path, `${JSON.stringify(next, null, 2)}\n`, "Update Rabbit download index", sha);
  }

  async listLibraryTree() {
    const response = await this.request(this.repoEndpoint(`/git/trees/${encodeURIComponent(this.config.branch)}?recursive=1`));
    if (response.truncated) throw new Error("GitHub truncated the repository tree; narrow the library folder before reconciling.");
    const prefix = `${this.config.root}/files/`;
    return response.tree.filter((item) => item.type === "blob" && item.path.startsWith(prefix));
  }

  loadAuditReport() {
    return this.getContent(`${this.config.root}/audit-report.json`);
  }

  static decodeTextContent(content) {
    return base64ToText(content);
  }
}

export async function sha256Hex(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
