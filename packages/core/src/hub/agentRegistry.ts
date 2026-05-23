import { Runtime } from "../runtime/types";

export class AgentRegistry {
  private readonly runtimes = new Map<string, Runtime>();

  constructor(private readonly defaultAgentName?: string) { }

  register(name: string, runtime: Runtime): void {
    if (this.runtimes.has(name)) {
      throw new Error(`Runtime '${name}' is already registered.`);
    }
    this.runtimes.set(name, runtime);
  }

  get(name: string): Runtime | undefined {
    return this.runtimes.get(name);
  }

  list(): string[] {
    return Array.from(this.runtimes.keys());
  }

  all(): Runtime[] {
    return Array.from(this.runtimes.values());
  }

  default(): Runtime {
    if (this.defaultAgentName) {
      const runtime = this.runtimes.get(this.defaultAgentName);
      if (!runtime) {
        throw new Error(`Default runtime '${this.defaultAgentName}' is not registered.`);
      }
      return runtime;
    }

    const first = this.runtimes.values().next().value;
    if (!first) {
      throw new Error("No runtimes registered.");
    }

    return first;
  }
}
