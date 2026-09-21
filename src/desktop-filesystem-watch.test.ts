import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import type { FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LinuxFilesystemWatchManager, type DesktopFilesystemChange } from "./desktop-filesystem-watch.js";

class FakeWatcher extends EventEmitter {
  closed = false;
  close(): void { this.closed = true; }
}

test("filesystem watcher emits metadata-only create/change/delete events and debounces duplicates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-fswatch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const watched = join(root, "watched");
  await mkdir(watched);
  let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
  let fake: FakeWatcher | undefined;
  let now = Date.parse("2026-09-20T12:00:00.000Z");
  const events: DesktopFilesystemChange[] = [];
  const manager = new LinuxFilesystemWatchManager({
    allowedRoots: [root],
    now: () => now,
    onEvent: (event) => events.push(event),
    watchFactory: (_path, _options, callback) => {
      listener = callback;
      fake = new FakeWatcher();
      return fake as unknown as FSWatcher;
    },
  });
  t.after(() => manager.close());

  const info = manager.start(watched, true);
  assert.equal(info.recursive, true);
  assert.equal(manager.list().length, 1);
  assert.ok(listener);

  const file = join(watched, "output.png");
  await writeFile(file, "fixture");
  listener!("rename", "output.png");
  listener!("rename", "output.png");
  assert.deepEqual(events.map((event) => event.type), ["created"], "duplicate rename should be debounced");

  now += 100;
  listener!("change", "output.png");
  assert.deepEqual(events.map((event) => event.type), ["created"], "initial content write should coalesce into create");

  now += 200;
  listener!("change", "output.png");
  assert.equal(events.at(-1)?.type, "changed", "a later modification should still emit changed");

  await unlink(file);
  now += 100;
  listener!("rename", "output.png");
  assert.equal(events.at(-1)?.type, "deleted");
  assert.equal(manager.list()[0]?.eventCount, 3);
  assert.equal(manager.list()[0]?.lastEventAt, "2026-09-20T12:00:00.400Z");

  const stopped = manager.stop(info.id);
  assert.equal(stopped.id, info.id);
  assert.equal(fake?.closed, true);
  assert.deepEqual(manager.list(), []);
});

test("filesystem watcher rejects paths outside allowed roots and symlink escapes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-fswatch-root-"));
  const outside = await mkdtemp(join(tmpdir(), "devspace-fswatch-outside-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const manager = new LinuxFilesystemWatchManager({
    allowedRoots: [root],
    onEvent: () => undefined,
    watchFactory: () => new FakeWatcher() as unknown as FSWatcher,
  });
  t.after(() => manager.close());

  assert.throws(() => manager.start(outside), /outside allowed roots/);
  const escaped = join(root, "escaped");
  await symlink(outside, escaped, "dir");
  assert.throws(() => manager.start(escaped), /outside allowed roots/);
});

test("filesystem watcher requires directories for recursive mode", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-fswatch-file-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "single.txt");
  await writeFile(file, "fixture");
  const manager = new LinuxFilesystemWatchManager({
    allowedRoots: [root],
    onEvent: () => undefined,
    watchFactory: () => new FakeWatcher() as unknown as FSWatcher,
  });
  t.after(() => manager.close());
  assert.throws(() => manager.start(file, true), /require a directory/);
});
