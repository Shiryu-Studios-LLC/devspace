export const DESKTOP_PERMISSION_IDS = [
  "windows",
  "displays",
  "processes",
  "events",
  "audio",
  "devices",
  "network",
  "logs",
  "tracing",
  "notifications",
  "virtual-desktops",
  "screen",
  "input",
  "accessibility",
  "clipboard-read",
  "clipboard-write",
  "notification-actions",
  "filesystem-watch",
  "browser",
] as const;

export type DesktopPermissionId = typeof DESKTOP_PERMISSION_IDS[number];
export type DesktopPermissionPolicy = Record<DesktopPermissionId, boolean>;
export type StoredDesktopPermissionPolicy = Partial<Record<DesktopPermissionId, boolean>>;

const DEFAULT_DENIED = new Set<DesktopPermissionId>([
  "screen",
  "input",
  "accessibility",
  "clipboard-read",
  "clipboard-write",
  "notification-actions",
  "filesystem-watch",
  "browser",
]);

export function desktopPermissionDefaultGranted(id: DesktopPermissionId): boolean {
  return !DEFAULT_DENIED.has(id);
}

export function defaultDesktopPermissionPolicy(): DesktopPermissionPolicy {
  return Object.fromEntries(
    DESKTOP_PERMISSION_IDS.map((id) => [id, desktopPermissionDefaultGranted(id)]),
  ) as DesktopPermissionPolicy;
}

export function resolveDesktopPermissionPolicy(
  stored: StoredDesktopPermissionPolicy | undefined,
): DesktopPermissionPolicy {
  const policy = defaultDesktopPermissionPolicy();
  if (!stored) return policy;
  for (const id of DESKTOP_PERMISSION_IDS) {
    const value = stored[id];
    if (typeof value === "boolean") policy[id] = value;
  }
  return policy;
}

export function desktopPermissionGranted(
  policy: DesktopPermissionPolicy,
  id: DesktopPermissionId,
): boolean {
  return policy[id] === true;
}
