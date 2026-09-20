import type { DevSpaceModule } from "./types.js";
import type { DevSpaceModuleContext } from "./types.js";
import type { DevSpaceModuleRegistry } from "./registry.js";

export class DevSpaceHotModuleSession {
  private hotModuleIds: Set<string>;

  constructor(
    private readonly registry: DevSpaceModuleRegistry,
    private readonly context: DevSpaceModuleContext,
    initialModules: readonly DevSpaceModule[],
  ) {
    this.hotModuleIds = new Set(initialModules.map((module) => module.id));
  }

  reload(modules: readonly DevSpaceModule[]): void {
    const nextIds = new Set(modules.map((module) => module.id));
    for (const id of this.hotModuleIds) {
      if (!nextIds.has(id)) this.registry.remove(id);
    }
    this.registry.reloadMany(modules, this.context);
    this.hotModuleIds = nextIds;
  }

  ids(): string[] {
    return [...this.hotModuleIds];
  }
}
