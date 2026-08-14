import { invalid } from "./errors.mjs";

const requiredKeys = ["name", "phase", "version", "lead_agent", "consumes", "produces", "permissions", "sensors", "gates", "retry"];
const allowedKeys = new Set([...requiredKeys, "depends_on", "deterministic"]);
const phases = new Set(["define", "acquire", "understand", "integrate", "govern", "maintain"]);
const safeStageName = /^[a-z][a-z0-9-]*$/;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw invalid(`${label} contains unsupported field: ${key}`);
}

function assertStringArray(value, label, { unique = false } = {}) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw invalid(`${label} must be an array of strings`);
  if (unique && new Set(value).size !== value.length) throw invalid(`${label} must not contain duplicates`);
}

function validateDefinition(stage) {
  if (!isPlainObject(stage)) throw invalid("Stage definition must be an object");
  assertExactKeys(stage, allowedKeys, "Stage definition");
  for (const key of requiredKeys) if (stage[key] === undefined) throw invalid(`Stage ${stage.name ?? "<missing>"} is missing ${key}`);

  if (typeof stage.name !== "string" || !safeStageName.test(stage.name)) throw invalid(`Unsafe or invalid stage name: ${stage.name ?? "<missing>"}`);
  if (!phases.has(stage.phase)) throw invalid(`Stage ${stage.name} has invalid phase`);
  if (!Number.isInteger(stage.version) || stage.version < 1) throw invalid(`Stage ${stage.name} has invalid version`);
  if (typeof stage.lead_agent !== "string" || stage.lead_agent.length === 0) throw invalid(`Stage ${stage.name} has invalid lead_agent`);
  assertStringArray(stage.consumes, `Stage ${stage.name} consumes`, { unique: true });
  assertStringArray(stage.produces, `Stage ${stage.name} produces`, { unique: true });
  assertStringArray(stage.sensors, `Stage ${stage.name} sensors`, { unique: true });
  if (stage.depends_on !== undefined) {
    assertStringArray(stage.depends_on, `Stage ${stage.name} depends_on`, { unique: true });
    for (const dependency of stage.depends_on) if (!safeStageName.test(dependency)) throw invalid(`Stage ${stage.name} has unsafe dependency name: ${dependency}`);
  }

  if (!isPlainObject(stage.permissions)) throw invalid(`Stage ${stage.name} has invalid permissions`);
  assertExactKeys(stage.permissions, new Set(["read", "write"]), `Stage ${stage.name} permissions`);
  if (!("read" in stage.permissions) || !("write" in stage.permissions)) throw invalid(`Stage ${stage.name} has invalid permissions`);
  assertStringArray(stage.permissions.read, `Stage ${stage.name} permissions.read`);
  assertStringArray(stage.permissions.write, `Stage ${stage.name} permissions.write`);

  if (!isPlainObject(stage.gates)) throw invalid(`Stage ${stage.name} has invalid gates`);
  assertExactKeys(stage.gates, new Set(["before", "after"]), `Stage ${stage.name} gates`);
  for (const gate of ["before", "after"]) {
    if (!(gate in stage.gates) || (stage.gates[gate] !== null && typeof stage.gates[gate] !== "string")) throw invalid(`Stage ${stage.name} has invalid ${gate} gate`);
  }

  if (!isPlainObject(stage.retry)) throw invalid(`Stage ${stage.name} has invalid retry policy`);
  assertExactKeys(stage.retry, new Set(["safe"]), `Stage ${stage.name} retry`);
  if (typeof stage.retry.safe !== "boolean") throw invalid(`Stage ${stage.name} has invalid retry policy`);
  if (stage.deterministic !== undefined && typeof stage.deterministic !== "boolean") throw invalid(`Stage ${stage.name} has invalid deterministic flag`);
}

export class StageGraph {
  constructor(definitions) {
    if (!Array.isArray(definitions)) throw invalid("Stage definitions must be an array");
    this.stages = new Map();
    for (const stage of definitions) {
      validateDefinition(stage);
      if (this.stages.has(stage.name)) throw invalid(`Duplicate stage: ${stage.name}`);
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

  get(name) {
    if (typeof name !== "string" || !safeStageName.test(name)) throw invalid(`Unsafe or invalid stage name: ${name ?? "<missing>"}`);
    const stage = this.stages.get(name);
    if (!stage) throw invalid(`Unknown stage: ${name}`);
    return structuredClone(stage);
  }

  dependentsOf(name) {
    this.get(name);
    const affected = new Set([name]);
    for (const candidate of this.order) if ((this.stages.get(candidate).depends_on ?? []).some((dependency) => affected.has(dependency))) affected.add(candidate);
    return [...affected];
  }
}
