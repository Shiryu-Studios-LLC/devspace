import type {
  DevSpaceModule,
  DevSpaceModuleContext,
  DevSpaceModuleState,
} from "./types.js";

type RemovableRegistration = { remove(): void };

export class DevSpaceModuleRegistry {
  private readonly states = new Map<string, DevSpaceModuleState>();
  private readonly registrations = new Map<string, RemovableRegistration[]>();

  register(module: DevSpaceModule, context: DevSpaceModuleContext): DevSpaceModuleState {
    this.removeRegistrations(module.id);

    if (module.enabled && !module.enabled(context)) {
      const state: DevSpaceModuleState = { id: module.id, status: "disabled" };
      this.states.set(module.id, state);
      return state;
    }

    const registrations: RemovableRegistration[] = [];
    const trackedContext: DevSpaceModuleContext = {
      ...context,
      server: trackedServer(context.server, (registration) => registrations.push(registration)),
    };

    try {
      module.register(trackedContext);
      this.registrations.set(module.id, registrations);
      const state: DevSpaceModuleState = { id: module.id, status: "ready" };
      this.states.set(module.id, state);
      return state;
    } catch (error) {
      removeRegistrations(registrations);
      const message = error instanceof Error ? error.message : String(error);
      const state: DevSpaceModuleState = { id: module.id, status: "failed", error: message };
      this.states.set(module.id, state);
      console.error(`[DevSpace] Secondary module ${module.id} failed to register: ${message}`);
      return state;
    }
  }

  reload(module: DevSpaceModule, context: DevSpaceModuleContext): DevSpaceModuleState {
    this.states.set(module.id, { id: module.id, status: "restarting" });
    return this.register(module, context);
  }

  registerMany(modules: readonly DevSpaceModule[], context: DevSpaceModuleContext): DevSpaceModuleState[] {
    return modules.map((module) => this.register(module, context));
  }

  reloadMany(modules: readonly DevSpaceModule[], context: DevSpaceModuleContext): DevSpaceModuleState[] {
    return modules.map((module) => this.reload(module, context));
  }

  remove(id: string): boolean {
    const existed = this.states.has(id) || this.registrations.has(id);
    this.removeRegistrations(id);
    this.states.delete(id);
    return existed;
  }

  get(id: string): DevSpaceModuleState | undefined {
    return this.states.get(id);
  }

  list(): DevSpaceModuleState[] {
    return [...this.states.values()];
  }

  private removeRegistrations(id: string): void {
    const registrations = this.registrations.get(id);
    if (!registrations) return;
    this.registrations.delete(id);
    removeRegistrations(registrations);
  }
}

function trackedServer(
  server: DevSpaceModuleContext["server"],
  onRegistration: (registration: RemovableRegistration) => void,
): DevSpaceModuleContext["server"] {
  return new Proxy(server, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = Reflect.apply(value, target, args) as unknown;
        if (isRemovableRegistration(result)) onRegistration(result);
        return result;
      };
    },
  });
}

function isRemovableRegistration(value: unknown): value is RemovableRegistration {
  return typeof value === "object"
    && value !== null
    && typeof (value as { remove?: unknown }).remove === "function";
}

function removeRegistrations(registrations: readonly RemovableRegistration[]): void {
  for (const registration of [...registrations].reverse()) {
    try {
      registration.remove();
    } catch (error) {
      console.error(`[DevSpace] Failed to remove secondary module registration: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
