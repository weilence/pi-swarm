import type { ModuleDefinition } from "../protocol/contracts.js";

export class ModuleRegistry {
  public constructor(private readonly modules: ModuleDefinition[]) {}

  public get(moduleId: string): ModuleDefinition {
    const module = this.modules.find((candidate) => candidate.id === moduleId);
    if (!module) {
      throw new Error(`Unknown module: ${moduleId}`);
    }
    return module;
  }

  public list(): ModuleDefinition[] {
    return [...this.modules];
  }
}
