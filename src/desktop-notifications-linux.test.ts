import assert from "node:assert/strict";
import test from "node:test";
import {
  LinuxNotificationMonitor,
  createLinuxNotificationControlProvider,
  linuxNotificationMonitorArgs,
} from "./desktop-notifications-linux.js";

test("Linux notification monitor restricts D-Bus capture to notification traffic", () => {
  const args = linuxNotificationMonitorArgs();
  assert.equal(args.at(-1), "monitor");
  assert.equal(args.some((arg) => arg === "org.freedesktop.Notifications"), false);
  assert.deepEqual(args.filter((arg) => arg.startsWith("--match=")), [
    "--match=type='method_call',path='/org/freedesktop/Notifications',interface='org.freedesktop.Notifications',member='Notify'",
    "--match=type='method_return',sender='org.freedesktop.Notifications'",
    "--match=type='signal',path='/org/freedesktop/Notifications',interface='org.freedesktop.Notifications',member='NotificationClosed'",
  ]);
});

test("Linux notification monitor records Notify calls, assigned IDs, and close signals", () => {
  let now = Date.parse("2026-09-20T06:20:00.000Z");
  const monitor = new LinuxNotificationMonitor({ maxNotifications: 10, now: () => now });

  monitor.ingest({
    type: "method_call",
    cookie: 9,
    sender: ":1.1209",
    destination: ":1.25",
    path: "/org/freedesktop/Notifications",
    interface: "org.freedesktop.Notifications",
    member: "Notify",
    payload: {
      type: "susssasa{sv}i",
      data: [
        "DevSpace Test",
        0,
        "ignored-icon",
        "Awareness test",
        "Read-only notification observation.",
        ["default", "Open"],
        {
          urgency: { type: "y", data: 1 },
          "sender-pid": { type: "x", data: 9460 },
          "desktop-entry": { type: "s", data: "devspace" },
          category: { type: "s", data: "device" },
          "image-data": { type: "ignored", data: "must-not-be-copied" },
        },
        -1,
      ],
    },
  });

  let notifications = monitor.recent();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.appName, "DevSpace Test");
  assert.equal(notifications[0]?.summary, "Awareness test");
  assert.equal(notifications[0]?.body, "Read-only notification observation.");
  assert.equal(notifications[0]?.pid, 9460);
  assert.equal(notifications[0]?.desktopEntry, "devspace");
  assert.equal(notifications[0]?.category, "device");
  assert.equal(notifications[0]?.urgency, 1);
  assert.deepEqual(notifications[0]?.actions, [{ id: "default", label: "Open" }]);
  assert.equal(Object.hasOwn(notifications[0] ?? {}, "appIcon"), false);
  assert.equal(Object.hasOwn(notifications[0] ?? {}, "hints"), false);

  monitor.ingest({
    type: "method_return",
    reply_cookie: 9,
    destination: ":1.1209",
    payload: { type: "u", data: [15] },
  });
  notifications = monitor.recent();
  assert.equal(notifications[0]?.notificationId, 15);

  now += 1_000;
  monitor.ingest({
    type: "signal",
    path: "/org/freedesktop/Notifications",
    interface: "org.freedesktop.Notifications",
    member: "NotificationClosed",
    payload: { type: "uu", data: [15, 2] },
  });
  notifications = monitor.recent();
  assert.equal(notifications[0]?.closedAt, "2026-09-20T06:20:01.000Z");
  assert.equal(notifications[0]?.closeReason, 2);
});

test("Linux notification control only targets observed open notifications and advertised actions", async () => {
  const calls: string[][] = [];
  const observed = [{
    id: "dbus::1.5:9",
    notificationId: 15,
    appName: "DevSpace Test",
    summary: "Action test",
    body: "",
    actions: [{ id: "default", label: "Open" }],
    expireTimeoutMs: -1,
    createdAt: "2026-09-20T06:20:00.000Z",
  }];
  const provider = createLinuxNotificationControlProvider(
    () => observed,
    {
      now: () => Date.parse("2026-09-20T06:21:00.000Z"),
      runBusctl: async (args) => { calls.push(args); },
    },
  );

  const dismissed = await provider({ type: "dismiss", id: observed[0]!.id });
  assert.equal(dismissed.completed, true);
  assert.equal(dismissed.notificationId, 15);
  assert.deepEqual(calls[0], [
    "--user", "call", "org.freedesktop.Notifications", "/org/freedesktop/Notifications",
    "org.freedesktop.Notifications", "CloseNotification", "u", "15",
  ]);

  const invoked = await provider({ type: "invoke-action", id: observed[0]!.id, actionId: "default" });
  assert.equal(invoked.actionId, "default");
  assert.deepEqual(calls[1], [
    "--user", "call", "org.freedesktop.Notifications", "/org/freedesktop/Notifications",
    "org.kde.NotificationManager", "InvokeAction", "us", "15", "default",
  ]);

  await assert.rejects(() => provider({ type: "dismiss", id: "unknown" }), /not observed/);
  await assert.rejects(
    () => provider({ type: "invoke-action", id: observed[0]!.id, actionId: "delete-everything" }),
    /not advertised/,
  );
  assert.equal(calls.length, 2, "rejected controls must not touch D-Bus");
});

test("Linux notification control rejects closed notifications", async () => {
  let calls = 0;
  const provider = createLinuxNotificationControlProvider(
    () => [{
      id: "closed",
      notificationId: 99,
      appName: "App",
      summary: "Closed",
      body: "",
      actions: [],
      expireTimeoutMs: -1,
      createdAt: "2026-09-20T06:20:00.000Z",
      closedAt: "2026-09-20T06:20:01.000Z",
    }],
    { runBusctl: async () => { calls += 1; } },
  );
  await assert.rejects(() => provider({ type: "dismiss", id: "closed" }), /already closed/);
  assert.equal(calls, 0);
});

test("Linux notification monitor keeps a bounded in-memory history", () => {
  const monitor = new LinuxNotificationMonitor({ maxNotifications: 2, now: () => 0 });
  for (let cookie = 1; cookie <= 3; cookie += 1) {
    monitor.ingest({
      type: "method_call",
      cookie,
      sender: ":1.5",
      path: "/org/freedesktop/Notifications",
      interface: "org.freedesktop.Notifications",
      member: "Notify",
      payload: {
        type: "susssasa{sv}i",
        data: ["App", 0, "", `Title ${cookie}`, "", [], {}, -1],
      },
    });
  }
  assert.deepEqual(monitor.recent().map((notification) => notification.summary), ["Title 2", "Title 3"]);
});
