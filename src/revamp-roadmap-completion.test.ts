import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const roadmapPath = join(repoRoot, "docs", "devspace-modular-awareness-roadmap.md");

test("modular-awareness roadmap has no unresolved implementation checkboxes", () => {
  const roadmap = readFileSync(roadmapPath, "utf8");
  const unresolved = roadmap
    .split(/\r?\n/)
    .filter((line) => /^\s*- \[ \]/.test(line));

  assert.deepEqual(unresolved, [], `Unresolved roadmap items:\n${unresolved.join("\n")}`);
  assert.match(roadmap, /platform-blocked, not an implementation TODO/);
  assert.match(roadmap, /Modular-awareness revamp implementation is complete/);
});
