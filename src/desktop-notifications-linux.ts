import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { DesktopNotificationInfo } from "./desktop-agent-protocol.js";

const BUSCTL = "/usr/bin/busctl";
const NOTIFICATION_SERVICE = "org.freedesktop.Notifications";
const NOTIFICATION_PATH = "/org/freedesktop/Notifications";
const NOTIFICATION_INTERFACE = "org.freedesktop.Notifications";
const DEFAULT_MAX_NOTIFICATIONS = 250;
const DEFAULT_RECENT_LIMIT = 100;

interface BusMessage {
  type?: string;
  cookie?: number;
  reply_cookie?: number;
  timestamp_realtime?: number;
  sender?: string;
  destination?: string;
  path?: string;
  interface?: string;
  member?: string;
  payload?: {
    type?: string;
    data?: unknown[];
  };
}

interface NotificationVariant {
  type?: string;
  data?: unknown;
}

export interface DesktopNotificationMonitor {
  start(): void;
  stop(): void;
  recent(limit?: number): DesktopNotificationInfo[];
}

export class LinuxNotificationMonitor implements DesktopNotificationMonitor {
  private readonly maxNotifications: number;
  private readonly now: () => number;
  private readonly notifications: DesktopNotificationInfo[] = [];
  private readonly byId = new Map<string, DesktopNotificationInfo>();
  private readonly byNotificationId = new Map<number, string>();
  private readonly pending = new Map<string, string>();
  private child?: ChildProcess;
  private buffer = "";

  constructor(options: { maxNotifications?: number; now?: () => number } = {}) {
    this.maxNotifications = options.maxNotifications ?? DEFAULT_MAX_NOTIFICATIONS;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.maxNotifications) || this.maxNotifications < 1) {
      throw new Error("Desktop notification max count must be a positive integer.");
    }
  }

  start(): void {
    if (this.child || !linuxNotificationAwarenessAvailable()) return;
    try {
      const child = spawn(BUSCTL, linuxNotificationMonitorArgs(), {
        stdio: ["ignore", "pipe", "pipe"],
        env: desktopBusEnvironment(),
      });
      this.child = child;
      if (!child.stdout) {
        child.kill("SIGTERM");
        this.child = undefined;
        return;
      }
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string | Buffer) => this.consume(chunk.toString()));
      child.once("error", () => {
        if (this.child === child) this.child = undefined;
      });
      child.once("close", () => {
        if (this.child === child) this.child = undefined;
      });
    } catch {
      this.child = undefined;
    }
  }

  stop(): void {
    const child = this.child;
    this.child = undefined;
    this.buffer = "";
    if (child && !child.killed) child.kill("SIGTERM");
  }

  recent(limit = DEFAULT_RECENT_LIMIT): DesktopNotificationInfo[] {
    const safeLimit = Number.isSafeInteger(limit)
      ? Math.max(1, Math.min(limit, this.maxNotifications))
      : DEFAULT_RECENT_LIMIT;
    return this.notifications.slice(-safeLimit).map(cloneNotification);
  }

  ingest(value: unknown): void {
    const message = asBusMessage(value);
    if (!message) return;
    if (isNotifyCall(message)) {
      this.ingestNotify(message);
      return;
    }
    if (isNotifyReturn(message)) {
      this.ingestNotifyReturn(message);
      return;
    }
    if (isNotificationClosed(message)) {
      this.ingestClosed(message);
    }
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.ingest(JSON.parse(line));
      } catch {
        // A malformed monitor line should not stop desktop awareness.
      }
    }
  }

  private ingestNotify(message: BusMessage): void {
    const data = message.payload?.data;
    if (!Array.isArray(data) || data.length < 8) return;
    const sender = typeof message.sender === "string" ? message.sender : "unknown";
    const cookie = safeInteger(message.cookie) ?? this.now();
    const id = `dbus:${sender}:${cookie}`;
    const hints = asRecord(data[6]);
    const pid = variantInteger(hints?.["sender-pid"]);
    const actions = actionPairs(data[5]);
    const replacesId = safeInteger(data[1]);
    const notification: DesktopNotificationInfo = {
      id,
      ...(replacesId && replacesId > 0 ? { replacesId } : {}),
      appName: stringValue(data[0]) ?? "Unknown application",
      summary: stringValue(data[3]) ?? "",
      body: stringValue(data[4]) ?? "",
      ...(pid !== undefined ? { pid } : {}),
      ...(variantString(hints?.["desktop-entry"]) ? { desktopEntry: variantString(hints?.["desktop-entry"]) } : {}),
      ...(variantString(hints?.category) ? { category: variantString(hints?.category) } : {}),
      ...(variantInteger(hints?.urgency) !== undefined ? { urgency: variantInteger(hints?.urgency) } : {}),
      actions,
      expireTimeoutMs: safeInteger(data[7]) ?? -1,
      createdAt: timestamp(message, this.now),
    };
    this.notifications.push(notification);
    this.byId.set(id, notification);
    if (replacesId && replacesId > 0) this.byNotificationId.set(replacesId, id);
    if (message.cookie !== undefined) this.pending.set(`${sender}:${message.cookie}`, id);
    this.trim();
  }

  private ingestNotifyReturn(message: BusMessage): void {
    const destination = typeof message.destination === "string" ? message.destination : undefined;
    const replyCookie = safeInteger(message.reply_cookie);
    if (!destination || replyCookie === undefined) return;
    const id = this.pending.get(`${destination}:${replyCookie}`);
    if (!id) return;
    this.pending.delete(`${destination}:${replyCookie}`);
    const notification = this.byId.get(id);
    const notificationId = safeInteger(message.payload?.data?.[0]);
    if (!notification || notificationId === undefined) return;
    notification.notificationId = notificationId;
    this.byNotificationId.set(notificationId, id);
  }

  private ingestClosed(message: BusMessage): void {
    const notificationId = safeInteger(message.payload?.data?.[0]);
    if (notificationId === undefined) return;
    const id = this.byNotificationId.get(notificationId);
    if (!id) return;
    const notification = this.byId.get(id);
    if (!notification || notification.closedAt) return;
    notification.closedAt = timestamp(message, this.now);
    const reason = safeInteger(message.payload?.data?.[1]);
    if (reason !== undefined) notification.closeReason = reason;
  }

  private trim(): void {
    while (this.notifications.length > this.maxNotifications) {
      const removed = this.notifications.shift();
      if (!removed) break;
      this.byId.delete(removed.id);
      if (removed.notificationId !== undefined && this.byNotificationId.get(removed.notificationId) === removed.id) {
        this.byNotificationId.delete(removed.notificationId);
      }
      for (const [key, id] of this.pending) {
        if (id === removed.id) this.pending.delete(key);
      }
    }
  }
}

export function linuxNotificationMonitorArgs(): string[] {
  return [
    "--user",
    "--json=short",
    `--match=type='method_call',path='${NOTIFICATION_PATH}',interface='${NOTIFICATION_INTERFACE}',member='Notify'`,
    `--match=type='method_return',sender='${NOTIFICATION_SERVICE}'`,
    `--match=type='signal',path='${NOTIFICATION_PATH}',interface='${NOTIFICATION_INTERFACE}',member='NotificationClosed'`,
    "monitor",
  ];
}

export function linuxNotificationAwarenessAvailable(): boolean {
  if (process.platform !== "linux" || !existsSync(BUSCTL)) return false;
  const env = desktopBusEnvironment();
  const address = env.DBUS_SESSION_BUS_ADDRESS;
  if (typeof address !== "string" || !address.startsWith("unix:path=")) return false;
  return existsSync(address.slice("unix:path=".length));
}

function desktopBusEnvironment(): NodeJS.ProcessEnv {
  const uid = process.getuid?.();
  const runtimeDir = process.env.XDG_RUNTIME_DIR || (uid === undefined ? undefined : `/run/user/${uid}`);
  const busAddress = process.env.DBUS_SESSION_BUS_ADDRESS || (runtimeDir ? `unix:path=${runtimeDir}/bus` : undefined);
  return {
    ...process.env,
    ...(runtimeDir ? { XDG_RUNTIME_DIR: runtimeDir } : {}),
    ...(busAddress ? { DBUS_SESSION_BUS_ADDRESS: busAddress } : {}),
  };
}

function isNotifyCall(message: BusMessage): boolean {
  return message.type === "method_call"
    && message.path === NOTIFICATION_PATH
    && message.interface === NOTIFICATION_INTERFACE
    && message.member === "Notify";
}

function isNotifyReturn(message: BusMessage): boolean {
  return message.type === "method_return"
    && Array.isArray(message.payload?.data)
    && message.payload?.type === "u"
    && typeof message.reply_cookie === "number";
}

function isNotificationClosed(message: BusMessage): boolean {
  return message.type === "signal"
    && message.path === NOTIFICATION_PATH
    && message.interface === NOTIFICATION_INTERFACE
    && message.member === "NotificationClosed";
}

function timestamp(message: BusMessage, now: () => number): string {
  const realtimeMicros = typeof message.timestamp_realtime === "number" && Number.isFinite(message.timestamp_realtime)
    ? message.timestamp_realtime
    : undefined;
  return new Date(realtimeMicros === undefined ? now() : Math.floor(realtimeMicros / 1_000)).toISOString();
}

function actionPairs(value: unknown): Array<{ id: string; label: string }> {
  if (!Array.isArray(value)) return [];
  const result: Array<{ id: string; label: string }> = [];
  for (let index = 0; index + 1 < value.length; index += 2) {
    const id = stringValue(value[index]);
    const label = stringValue(value[index + 1]);
    if (id !== undefined && label !== undefined) result.push({ id, label });
  }
  return result;
}

function variantString(value: unknown): string | undefined {
  const variant = asRecord(value) as NotificationVariant | undefined;
  return stringValue(variant?.data);
}

function variantInteger(value: unknown): number | undefined {
  const variant = asRecord(value) as NotificationVariant | undefined;
  return safeInteger(variant?.data);
}

function asBusMessage(value: unknown): BusMessage | undefined {
  const record = asRecord(value);
  return record ? record as BusMessage : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function cloneNotification(notification: DesktopNotificationInfo): DesktopNotificationInfo {
  return {
    ...notification,
    actions: notification.actions.map((action) => ({ ...action })),
  };
}
