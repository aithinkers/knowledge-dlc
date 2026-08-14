import { denied, invalid } from "./errors.mjs";

export class SensorRunner {
  constructor({ sensors, clock, audit }) { this.sensors = new Map(sensors.map((sensor) => [sensor.id, sensor])); this.clock = clock; this.audit = audit; }
  async run(ids, context, waivers = []) {
    const results = [];
    for (const id of ids) {
      const sensor = this.sensors.get(id); if (!sensor) throw invalid(`Unknown sensor: ${id}`);
      const first = await sensor.evaluate(structuredClone(context)); const second = await sensor.evaluate(structuredClone(context));
      if (JSON.stringify(first) !== JSON.stringify(second)) throw invalid(`Sensor is nondeterministic: ${id}`);
      const result = { sensor_id: id, version: sensor.version, blocking: sensor.blocking, ...first };
      if (result.status === "failed") {
        const waiver = waivers.find((candidate) => candidate.sensor_id === id && candidate.scope === context.scope && Date.parse(candidate.expires_at) > this.clock.millis());
        if (waiver && waiver.id && waiver.authority && waiver.reason) result.waiver = { id: waiver.id, authority: waiver.authority, reason: waiver.reason, expires_at: waiver.expires_at };
        else if (result.blocking) result.blocks = true;
      }
      results.push(result);
      if (this.audit) await this.audit.append(context.workflow_id, { actor: context.actor, stage: context.stage, action: "sensor.completed", subject: id, result: result.status, policy_version: context.policy_version });
    }
    return { results, allowed: !results.some((result) => result.blocks) };
  }
  assertAllowed(report) { if (!report.allowed) throw denied("Blocking sensor failed", { sensors: report.results.filter((result) => result.blocks).map((result) => result.sensor_id) }); }
}
