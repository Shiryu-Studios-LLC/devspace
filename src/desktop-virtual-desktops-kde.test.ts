import assert from "node:assert/strict";
import test from "node:test";
import { parseKdeVirtualDesktopProperties } from "./desktop-virtual-desktops-kde.js";

test("KDE virtual desktop properties decode current desktop and ordering", () => {
  const snapshot = parseKdeVirtualDesktopProperties({
    count: { type: "u", data: 2 },
    current: { type: "s", data: "desktop-2" },
    desktops: {
      type: "a(uss)",
      data: [
        [0, "desktop-1", "Main"],
        [1, "desktop-2", "VR"],
      ],
    },
    navigationWrappingAround: { type: "b", data: true },
    rows: { type: "u", data: 1 },
  }, () => Date.parse("2026-09-20T06:50:00.000Z"));

  assert.equal(snapshot.generatedAt, "2026-09-20T06:50:00.000Z");
  assert.equal(snapshot.count, 2);
  assert.equal(snapshot.currentId, "desktop-2");
  assert.equal(snapshot.navigationWrappingAround, true);
  assert.deepEqual(snapshot.desktops, [
    { position: 0, id: "desktop-1", name: "Main", current: false },
    { position: 1, id: "desktop-2", name: "VR", current: true },
  ]);
});

test("KDE virtual desktop parser rejects invalid property payloads", () => {
  assert.throws(() => parseKdeVirtualDesktopProperties(null), /invalid virtual desktop response/);
});
