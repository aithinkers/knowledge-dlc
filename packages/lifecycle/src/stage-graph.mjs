import { invalid } from "./errors.mjs";

export class StageGraph {
  constructor(definitions) {
    this.stages = new Map();
    for (const stage of definitions) {
      if (!stage?.name || this.stages.has(stage.name)) throw invalid(`Duplicate or missing stage: ${stage?.name ?? "<missing>"}`);
      for (const key of ["phase", "version", "lead_agent", "consumes", "produces", "permissions", "sensors", "gates", "retry"]) {
        if (stage[key] === undefined) throw invalid(`Stage ${stage.name} is missing ${key}`);
      }
      if (!Array.isArray(stage.permissions.read) || !Array.isArray(stage.permissions.write)) throw invalid(`Stage ${stage.name} has invalid permissions`);
      if (!("before" in stage.gates) || !("after" in stage.gates) || typeof stage.retry.safe !== "boolean") throw invalid(`Stage ${stage.name} has invalid gates or retry policy`);
      this.stages.set(stage.name, structuredClone(stage));
    }
    for (const stage of this.stages.values()) {
      for (const dependency of stage.depends_on ?? []) if (!this.stages.has(dependency)) throw invalid(`Unknown stage dependency: ${dependency}`);
    }
    this.order = this.#topologicalOrder();
  }

  #topologicalOrder() {
    const visiting = new Set(); const visited = new Set(); const order = [];
    const visit = (name) => {
      if (visiting.has(name)) throw invalid(`Stage dependency cycle at ${name}`);
      if (visited.has(name)) return;
      visiting.add(name);
      for (const dependency of this.stages.get(name).depends_on ?? []) visit(dependency);
      visiting.delete(name); visited.add(name); order.push(name);
    };
    for (const name of this.stages.keys()) visit(name);
    return order;
  }

  get(name) { const stage = this.stages.get(name); if (!stage) throw invalid(`Unknown stage: ${name}`); return structuredClone(stage); }
  dependentsOf(name) {
    const affected = new Set([name]);
    for (const candidate of this.order) if ((this.stages.get(candidate).depends_on ?? []).some((dependency) => affected.has(dependency))) affected.add(candidate);
    return [...affected];
  }
}
