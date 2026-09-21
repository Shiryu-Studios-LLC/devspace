export type ApplicationIntegrationTransport =
  | "upstream-mcp"
  | "desktop-adapter"
  | "browser-session";

export type AwarenessSourceKind = "generic" | "application-adapter";
export type AwarenessSourcePriority = "primary" | "secondary";

export interface ApplicationIntegrationDescriptor {
  id: string;
  application: string;
  transport: ApplicationIntegrationTransport;
  optional: true;
  enabledByDefault: true;
  sourceKind: "application-adapter";
  sourcePriority: "secondary";
}

const OPTIONAL_APPLICATION_INTEGRATIONS = [
  { id: "unity", application: "Unity", transport: "upstream-mcp" },
  { id: "unreal", application: "Unreal", transport: "upstream-mcp" },
  { id: "blockbench", application: "Blockbench", transport: "upstream-mcp" },
  { id: "steamvr", application: "SteamVR", transport: "desktop-adapter" },
  { id: "obs", application: "OBS", transport: "desktop-adapter" },
  { id: "shiryu-audio", application: "ShiryuAudio", transport: "desktop-adapter" },
  { id: "shiryugen", application: "ShiryuGen", transport: "desktop-adapter" },
  { id: "browser", application: "Browser", transport: "browser-session" },
] as const satisfies ReadonlyArray<{
  id: string;
  application: string;
  transport: ApplicationIntegrationTransport;
}>;

export const applicationIntegrations: readonly ApplicationIntegrationDescriptor[] =
  OPTIONAL_APPLICATION_INTEGRATIONS.map((integration) => ({
    ...integration,
    optional: true as const,
    enabledByDefault: true as const,
    sourceKind: "application-adapter" as const,
    sourcePriority: "secondary" as const,
  }));

export function applicationIntegration(id: string): ApplicationIntegrationDescriptor | undefined {
  return applicationIntegrations.find((integration) => integration.id === id);
}

export function applicationAdapterMetadata(
  id: string,
  fallbackApplication = id,
): Pick<
  ApplicationIntegrationDescriptor,
  "application" | "optional" | "sourceKind" | "sourcePriority"
> {
  const integration = applicationIntegration(id);
  return {
    application: integration?.application ?? fallbackApplication,
    optional: true,
    sourceKind: "application-adapter",
    sourcePriority: "secondary",
  };
}

export const genericAwarenessMetadata = {
  sourceKind: "generic" as const,
  sourcePriority: "primary" as const,
};
