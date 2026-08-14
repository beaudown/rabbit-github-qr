import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFilePath,
  emptyIndex,
  mergeIndexes,
  normalizeRoot,
  reconcileIndex,
  safeFilename,
} from "../src/lib/model.js";

test("normalizes the library root and filenames", () => {
  assert.equal(normalizeRoot("//rabbit-files//releases/"), "rabbit-files/releases");
  assert.equal(safeFilename("Rabbit Browser 1.2.0 (signed).APK"), "Rabbit-Browser-1-2-0-signed.apk");
});

test("builds predictable dated repository paths", () => {
  assert.equal(buildFilePath("rabbit-files", "id.apk", new Date("2026-08-14T12:00:00Z")), "rabbit-files/files/2026/08/id.apk");
});

test("merges local queued files with remote metadata", () => {
  const local = emptyIndex();
  local.files = [{ id: "one", name: "local.apk", path: "rabbit-files/files/one.apk", localState: "queued" }];
  const remote = emptyIndex();
  remote.files = [{ id: "two", name: "remote.apk", path: "rabbit-files/files/two.apk" }];
  const merged = mergeIndexes(local, remote);
  assert.deepEqual(new Set(merged.files.map((file) => file.id)), new Set(["one", "two"]));
  assert.equal(merged.files.find((file) => file.id === "one").syncState, "local-only");
  assert.equal(merged.files.find((file) => file.id === "two").syncState, "indexed");
});

test("reconciliation separates local-only, missing, remote-only, and ignored paths", () => {
  const index = emptyIndex();
  index.files = [
    { id: "cached", path: "rabbit-files/files/cached.apk" },
    { id: "lost", path: "rabbit-files/files/lost.apk" },
  ];
  index.ignoredRemotePaths = [{ path: "rabbit-files/files/ignored.apk" }];
  const findings = reconcileIndex(index, ["rabbit-files/files/remote.apk", "rabbit-files/files/ignored.apk"], new Set(["cached"]));
  assert.deepEqual(findings.map((item) => item.kind).sort(), ["local-only", "missing-remote", "remote-only"]);
});
