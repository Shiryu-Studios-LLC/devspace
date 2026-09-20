import type {
  DevSpaceModule,
  DevSpaceModuleContext,
  DevSpaceModuleState,
} from "./types.js";

export class DevSpaceModuleRegistry {
  private readonly states = new Map<string, DevSpaceModuleState>();

  register(module: DevSpaceModule, context: DevSpaceModuleContext): DevSpaceModuleState {
    if (module.enabled && !module.enabled(context)) {
      const state: DevSpaceModuleState = { id: module.id, status: "disabled" };
      this.states.set(module.id, state);
      return state;
    }

    try {
      module.register(context);
      const state: DevSpaceModuleState = { id: module.id, status: "ready" };
      this.states.set(module.id, state);
      return state;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const state: DevSpaceModuleState = { id: module.id, status: "failed", error: message };
      this.states.set(module.id, state);
      console.error(`[DevSpace] Secondary module ${module.id} failed to register: ${message}`);
      return state;
    }
  }

  registerMany(modules: readonly DevSpaceModule[], context: DevSpaceModuleContext): DevSpaceModuleState[] {
    return modules.map((module) => this.register(module, context));
  }

  get(id: string): DevSpaceModuleState | undefined {
    return this.states.get(id);
  }

  list(): DevSpaceModuleState[] {
    return [...this.states.values()];
  }
}
