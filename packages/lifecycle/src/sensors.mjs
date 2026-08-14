import { canonicalJson } from "../../core/index.mjs";

import { denied, fromNativeError, invalid } from "./errors.mjs";

const sensorIdPattern = /^[a-z][a-z0-9-]*$/;
const statuses = new Set(["passed", "failed", "warning", "error"]);

function validateSensor(sensor, seen) {
  if (!sensor || typeof sensor !== "object" || Array.isArray(sensor)) throw invalid("Sensor definition must be an object");
  if (typeof sensor.id !== "string" || !sensorIdPattern.test(sensor.id)) throw invalid(`Invalid sensor id: ${sensor.id ?? "<missing>"}`);
  if (seen.has(sensor.id)) throw invalid(`Duplicate sensor id: ${sensor.id}`);
  if (!Number.isInteger(sensor.version) || sensor.version < 1) throw invalid(`Sensor ${sensor.id} has invalid version`);
  if (typeof sensor.blocking !== "boolean") throw invalid(`Sensor ${sensor.id} must declare blocking`);
  if (typeof sensor.evaluate !== "function") throw invalid(`Sensor ${sensor.id} must declare evaluate`);
  seen.add(sensor.id);
}

function sanitizeEvaluation(value, sensor) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {
    status: "error",
    finding: { code: "KDLC_SENSOR_FAILED", message: `Sensor ${sensor.id} returned an invalid result` }
  };
  const { sensor_id: ignoredId, version: ignoredVersion, blocking: ignoredBlocking, blocks: ignoredBlocks, waiver: ignoredWaiver, ...reported } = value;
  if (!statuses.has(reported.status)) return {
    ...reported,
    status: "error",
    finding: { code: "KDLC_SENSOR_FAILED", message: `Sensor ${sensor.id} returned an invalid status` }
  };
  return reported;
}

function equivalent(left, right) {
  try { return canonicalJson(left) === canonicalJson(right); }
  catch { return false; }
}

export class SensorRunner {
  constructor({ sensors, clock, audit, waiverAuthorities = [] }) {
    if (!Array.isArray(sensors)) throw invalid("Sensors must be an array");
    const seen = new Set();
    for (const sensor of sensors) validateSensor(sensor, seen);
    this.sensors = new Map(sensors.map((sensor) => [sensor.id, sensor]));
    this.clock = clock;
    this.audit = audit;
    this.waiverAuthorities = new Set(waiverAuthorities);
  }

  async #evaluate(sensor, context) {
    try { return sanitizeEvaluation(await sensor.evaluate(structuredClone(context)), sensor); }
    catch (error) {
      const converted = fromNativeError(error, {
        code: "KDLC_SENSOR_FAILED",
        category: "sensor-failure",
        message: `Sensor evaluation failed: ${sensor.id}`,
        retryable: true,
        details: { sensor_id: sensor.id }
      });
      return { status: "error", finding: converted.structured("sensor-evaluation") };
    }
  }

  async run(ids, context, waivers = []) {
    if (!Array.isArray(ids)) throw invalid("Sensor ids must be an array");
    const results = [];
    for (const id of ids) {
      const sensor = this.sensors.get(id);
      if (!sensor) throw invalid(`Unknown sensor: ${id}`);
      const first = await this.#evaluate(sensor, context);
      const second = await this.#evaluate(sensor, context);
      if (!equivalent(first, second)) throw denied(`Sensor is nondeterministic: ${id}`, { sensors: [id] });

      const result = {
        ...first,
        sensor_id: id,
        version: sensor.version,
        blocking: sensor.blocking,
        blocks: sensor.blocking && (first.status === "failed" || first.status === "error")
      };
      if (result.status === "failed") {
        const waiver = waivers.find((candidate) => typeof candidate?.id === "string" && candidate.id.length > 0
          && candidate.sensor_id === id
          && typeof candidate.scope === "string"
          && candidate.scope === context.scope
          && typeof candidate.authority === "string" && this.waiverAuthorities.has(candidate.authority)
          && typeof candidate.reason === "string" && candidate.reason.length > 0
          && typeof candidate.expires_at === "string"
          && Number.isFinite(Date.parse(candidate.expires_at))
          && Date.parse(candidate.expires_at) > this.clock.millis());
        if (waiver && typeof this.audit?.append === "function") {
          await this.audit.append(context.workflow_id, {
            actor: waiver.authority, stage: context.stage, action: "sensor.waived", subject: id,
            result: "waived", reason: waiver.reason, waiver_id: waiver.id, policy_version: context.policy_version,
            idempotency_key: `sensor-waiver:${context.workflow_id}:${context.stage}:${id}:${waiver.id}`
          });
          result.waiver = { id: waiver.id, authority: waiver.authority, reason: waiver.reason, expires_at: waiver.expires_at };
          result.blocks = false;
        }
      }
      results.push(result);
      if (this.audit) await this.audit.append(context.workflow_id, {
        actor: context.actor,
        stage: context.stage,
        action: "sensor.completed",
        subject: id,
        result: result.status,
        policy_version: context.policy_version
      });
    }
    return { results, allowed: !results.some((result) => result.blocks) };
  }

  assertAllowed(report) {
    if (!report?.allowed) throw denied("Blocking sensor failed", {
      sensors: (report?.results ?? []).filter((result) => result.blocks).map((result) => result.sensor_id)
    });
  }
}
