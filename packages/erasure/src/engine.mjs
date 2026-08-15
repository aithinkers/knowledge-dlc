import { createHash } from "node:crypto";

import { artifactHash, canonicalJson } from "../../core/index.mjs";
import { JobRegistry } from "../../lifecycle/src/index.mjs";
import { conflict, denied, incomplete, invalid } from "./errors.mjs";
import { RevocationGuard } from "./guard.mjs";
import { resolveImpact } from "./inventory.mjs";

const ID = /^[A-Za-z0-9._-]{1,128}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;

function opaque(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function minimalTombstone({ source, surface, decision, jobId }) {
  const allowed = new Set(decision.tombstone_fields);
  return {
    api_version: "kdlc.dev/erasure-tombstone/v1alpha1",
    status: "deleted",
    ...(allowed.has("source_id") ? { source_id: source.id } : {}),
    ...(allowed.has("source_hash") ? { source_hash: source.hash } : {}),
    ...(allowed.has("event_id") ? { event_id: jobId } : {}),
    surface: { kind: surface.kind },
    decision_hash: artifactHash(decision),
  };
}

function sameIds(left, right) {
  return canonicalJson([...left].sort()) === canonicalJson([...right].sort());
}

function revocationInvalidation(plan, surface) {
  return {
    api_version: "kdlc.dev/revocation-impact-state/v1alpha1",
    surface: { id: surface.id, kind: surface.kind },
    status: ["concept", "proposal", "receipt"].includes(surface.kind) ? "review-required" : "invalidated",
    source_hash: plan.source.hash,
    impact_hash: artifactHash(plan.impact),
  };
}

export class RevocationEngine {
  constructor({ store, clock, ids, audit, authority, inventory, jobs, externalProcessors = {}, fault = async () => {}, coordination = {} }) {
    if (!store || !clock || !ids || !audit || !authority || !inventory)
      throw invalid("Revocation engine requires durable storage, clock, IDs, audit, authority, and inventory");
    Object.assign(this, { store, clock, ids, audit, authority, inventory, externalProcessors, fault, coordination });
    this.jobs = jobs ?? new JobRegistry({ store, clock, ids, audit, coordination });
    this.guard = new RevocationGuard({ store });
  }

  planPath(workflowId, jobId) { return `workflow/runs/${workflowId}/erasure/${jobId}/plan.json`; }
  receiptPath(workflowId, jobId) { return `workflow/runs/${workflowId}/erasure/${jobId}/receipt.json`; }
  blockedPath(workflowId, jobId) { return `workflow/runs/${workflowId}/erasure/${jobId}/blocked.json`; }
  idempotencyPath(projectId, workflowId, key) { return `governance/erasure-idempotency/${opaque(`${projectId}\0${workflowId}\0${key}`).slice(7)}.json`; }
  impactPath(sourceId, surfaceId) { return `${this.guard.path(sourceId).replace(/\.json$/, "")}/impacts/${surfaceId}.json`; }

  #assertPlan(plan, workflowId = plan?.workflow_id, jobId = plan?.job_id) {
    if (!plan || plan.api_version !== "kdlc.dev/erasure-plan/v1alpha1" ||
      plan.workflow_id !== workflowId || plan.job_id !== jobId ||
      plan.source?.id !== plan.request?.source_id || plan.source?.hash !== plan.request?.source_hash ||
      plan.source?.id !== plan.decision?.source?.id || plan.source?.hash !== plan.decision?.source?.hash ||
      plan.request?.action !== plan.decision?.action ||
      !Array.isArray(plan.surfaces) || artifactHash(plan.surfaces) !== plan.impact?.surface_plan_hash ||
      !sameIds(plan.surfaces.map(({ id }) => id), (plan.impact?.nodes ?? []).map(({ id }) => id)))
      throw denied("Persisted erasure plan integrity is invalid");
  }

  coordinate(sourceId, action) {
    return this.store.withMutex(`governance/revocation-locks/${opaque(sourceId).slice(7)}`, {
      owner: `erasure:${sourceId}:${this.ids.next("coord")}`,
      clock: this.clock,
      ...this.coordination,
    }, action);
  }

  coordinateIdempotency(projectId, workflowId, key, action) {
    return this.store.withMutex(`${this.idempotencyPath(projectId, workflowId, key)}.lock`, {
      owner: `erasure-idempotency:${this.ids.next("coord")}`,
      clock: this.clock,
      ...this.coordination,
    }, action);
  }

  coordinateInventory(action) {
    return this.store.withMutex("governance/erasure-inventory-lock", {
      owner: `erasure-inventory:${this.ids.next("coord")}`,
      clock: this.clock,
      ...this.coordination,
    }, action);
  }

  async #barrierMutation(action) {
    return this.coordinateInventory(async () => {
      const path = this.guard.generationPath();
      const current = await this.guard.generation();
      if (current === null) throw incomplete("Revocation barrier generation is invalid");
      const begun = current % 2 === 0 ? current + 1 : current + 2;
      await this.store.writeJsonAtomic(path, { generation: begun });
      const result = await action();
      await this.store.writeJsonAtomic(path, { generation: begun + 1 });
      return result;
    });
  }

  async #installBarrier(plan, state = plan.request.action === "erase" ? "erasure-pending" : "revoked", coordinated = false) {
    if (!coordinated) return this.#barrierMutation(() => this.#installBarrier(plan, state, true));
    const path = this.guard.path(plan.source.id);
    const barrier = {
      api_version: "kdlc.dev/revocation-barrier/v1alpha1",
      source: structuredClone(plan.source),
      state,
      workflow_id: plan.workflow_id,
      job_id: plan.job_id,
      impact_hash: artifactHash(plan.impact),
      decision_hash: artifactHash(plan.decision),
      activated_at: plan.created_at,
    };
    if (await this.store.exists(path)) {
      const existing = await this.store.readJson(path);
      if (existing.source?.id !== plan.source.id || existing.source?.hash !== plan.source.hash)
        throw conflict("Revocation barrier conflicts with another source version");
      if (existing.job_id !== plan.job_id || existing.decision_hash !== barrier.decision_hash)
        throw conflict("Source already has another active revocation workflow");
      if (existing.state === state || existing.state === "erased" || existing.state === "held") return existing;
    }
    await this.store.writeJsonAtomic(path, barrier);
    return barrier;
  }

  async #finalizeBlocked(plan) {
    const path = this.blockedPath(plan.workflow_id, plan.job_id);
    const blocked = {
      api_version: "kdlc.dev/erasure-blocked/v1alpha1",
      job_id: plan.job_id,
      source: structuredClone(plan.source),
      decision_hash: artifactHash(plan.decision),
      impact_hash: artifactHash(plan.impact),
      blocked: structuredClone(plan.decision.blocked),
      recorded_at: this.clock.now(),
    };
    if (!(await this.store.exists(path))) await this.store.writeJsonAtomic(path, blocked);
    let current = await this.jobs.get(plan.job_id);
    if (current.state === "queued") current = await this.jobs.transition(current.job_id, "running");
    if (current.state === "running") await this.jobs.transition(current.job_id, "failed", {
      error: { code: "KDLC_ERASURE_POLICY_DENIED", message: "Erasure is blocked by retention or legal hold" },
    });
    await this.audit.append(plan.workflow_id, {
      actor: plan.decision.authority.actor,
      action: "erasure.blocked",
      subject: opaque(plan.source.id),
      input_hash: artifactHash(plan.decision),
      result: "blocked",
      policy_version: `${plan.decision.policy.id}@${plan.decision.policy.version}`,
      idempotency_key: `erasure-blocked:${plan.job_id}`,
    });
    return blocked;
  }

  async start({ authorization, projectId, workflowId, sourceId, sourceHash, action, reason, policyId, policyVersion, idempotencyKey }) {
    if (![projectId, workflowId, sourceId, reason, policyId, policyVersion, idempotencyKey].every((value) => ID.test(value ?? "")) ||
      !HASH.test(sourceHash ?? "") || !["revoke", "erase"].includes(action))
      throw invalid("Revocation job request is invalid");
    const request = {
      action,
      reason,
      policy_id: policyId,
      policy_version: policyVersion,
      source_id: sourceId,
      source_hash: sourceHash,
    };
    const authenticated = this.authority.resolve(authorization);
    return this.coordinateIdempotency(projectId, workflowId, idempotencyKey, () => this.coordinate(sourceId, async () => {
      const idempotencyPath = this.idempotencyPath(projectId, workflowId, idempotencyKey);
      if (await this.store.exists(idempotencyPath)) {
        const entry = await this.store.readJson(idempotencyPath);
        if (entry.request_hash !== artifactHash(request) || entry.authority_hash !== artifactHash(authenticated))
          throw conflict("Erasure idempotency key was reused with changed authority or input");
        const existingPlan = await this.store.readJson(this.planPath(workflowId, entry.job_id));
        this.#assertPlan(existingPlan, workflowId, entry.job_id);
        await this.#installBarrier(existingPlan, existingPlan.decision.allowed ? undefined : "held");
        await this.audit.append(workflowId, {
          actor: existingPlan.decision.authority.actor,
          action: "source.revoked",
          subject: opaque(sourceId),
          input_hash: sourceHash,
          result: existingPlan.decision.allowed ? "revoked" : "held",
          policy_version: `${policyId}@${policyVersion}`,
          idempotency_key: `revocation:${entry.job_id}`,
        });
        if (!existingPlan.decision.allowed) await this.#finalizeBlocked(existingPlan);
        return {
          job: await this.jobs.get(entry.job_id),
          impact: existingPlan.impact,
          decision: existingPlan.decision,
          reused: true,
        };
      }
      const snapshot = await this.inventory.snapshot();
      const source = { id: sourceId, hash: sourceHash };
      const impact = resolveImpact(snapshot, source);
      const decision = this.authority.decide({ authorization, request, impact });
      if (decision.authority.actor !== authenticated.authority || decision.authorization_hash !== artifactHash(authenticated)) throw denied("Retention decision authority identity drifted");
      if (!this.authority.verify(decision, impact)) throw denied("Retention decision proof is invalid");
      const created = await this.jobs.create({
        principal: decision.authority.actor,
        projectId,
        workflowId,
        operation: action === "erase" ? "source.erase" : "source.revoke",
        idempotencyKey,
        inputHashes: { request: artifactHash(request), inventory: impact.inventory_hash },
        dependencies: { policy: `${policyId}@${policyVersion}` },
        total: impact.nodes.length,
      });
      const planPath = this.planPath(workflowId, created.job.job_id);
      let plan = {
        api_version: "kdlc.dev/erasure-plan/v1alpha1",
        job_id: created.job.job_id,
        project_id: projectId,
        workflow_id: workflowId,
        source,
        request,
        impact,
        decision,
        surfaces: snapshot.surfaces.filter(({ id }) => impact.nodes.some((node) => node.id === id)),
        completed_surface_ids: [],
        external_receipts: {},
        state: decision.allowed ? "planned" : "blocked",
        created_at: created.job.created_at,
        updated_at: created.job.updated_at,
      };
      if (await this.store.exists(planPath)) {
        const existing = await this.store.readJson(planPath);
        if (artifactHash(existing.request) !== artifactHash(request) || existing.impact.inventory_hash !== impact.inventory_hash)
          throw conflict("Idempotent revocation plan changed");
        plan = existing;
      } else await this.store.writeJsonAtomic(planPath, plan);
      await this.store.writeJsonAtomic(idempotencyPath, {
        version: 1,
        authority_hash: artifactHash(authenticated),
        request_hash: artifactHash(request),
        job_id: created.job.job_id,
      });
      await this.#installBarrier(plan, plan.decision.allowed ? undefined : "held");
      await this.audit.append(workflowId, {
        actor: plan.decision.authority.actor,
        action: "source.revoked",
        subject: opaque(sourceId),
        input_hash: sourceHash,
        result: plan.decision.allowed ? "revoked" : "held",
        policy_version: `${policyId}@${policyVersion}`,
        idempotency_key: `revocation:${created.job.job_id}`,
      });
      if (!plan.decision.allowed) {
        await this.#finalizeBlocked(plan);
      }
      return { job: await this.jobs.get(created.job.job_id), impact: plan.impact, decision: plan.decision, reused: created.reused };
    }));
  }

  async #treatSurface(plan, surface) {
    if (plan.request.action === "revoke") {
      const invalidation = revocationInvalidation(plan, surface);
      await this.store.writeJsonAtomic(this.impactPath(plan.source.id, surface.id), invalidation);
      return null;
    }
    if (surface.strategy === "external-delete") {
      const processor = this.externalProcessors[surface.processor];
      if (!processor?.delete || !processor?.verify) throw incomplete("Configured external erasure processor is unavailable", { processor: surface.processor });
      const receipt = await processor.delete({ objectId: surface.object_id, idempotencyKey: `${plan.job_id}:${surface.id}`, source: structuredClone(plan.source) });
      if (!receipt || receipt.api_version !== "kdlc.dev/external-deletion-receipt/v1alpha1" ||
        receipt.processor !== surface.processor || receipt.object_id_hash !== opaque(surface.object_id) ||
        !ID.test(receipt.deletion_id ?? "") || !HASH.test(receipt.proof_hash ?? ""))
        throw incomplete("External deletion processor returned an invalid minimized receipt", { processor: surface.processor });
      return structuredClone(receipt);
    }
    const tombstone = minimalTombstone({ source: plan.source, surface, decision: plan.decision, jobId: plan.job_id });
    const tombstoneContent = `${canonicalJson(tombstone)}\n`;
    const exists = await this.store.exists(surface.path);
    if (surface.strategy === "purge") {
      if (!exists) return null;
      const actual = await this.store.tokenOf(surface.path);
      if (actual !== surface.token) throw conflict("Surface changed after impact analysis", { surface_id: surface.id });
      await this.store.remove(surface.path);
      return null;
    }
    if (exists) {
      const actual = await this.store.tokenOf(surface.path);
      const next = this.store.token(tombstoneContent);
      if (actual === next) return null;
      if (actual !== surface.token) throw conflict("Surface changed after impact analysis", { surface_id: surface.id });
    } else if (surface.token !== null) throw conflict("Surface disappeared after impact analysis", { surface_id: surface.id });
    await this.store.writeTextAtomic(surface.path, tombstoneContent);
    return null;
  }

  async #verify(plan) {
    const current = await this.inventory.snapshot();
    const currentImpact = resolveImpact(current, plan.source);
    const plannedIds = new Set(plan.impact.nodes.map(({ id }) => id));
    const currentIds = new Set(currentImpact.nodes.map(({ id }) => id));
    if (!sameIds(plannedIds, currentIds))
      throw incomplete("Known impacted surface set changed during erasure", {
        added: [...currentIds].filter((id) => !plannedIds.has(id)).sort(),
        missing: [...plannedIds].filter((id) => !currentIds.has(id)).sort(),
      });
    const currentById = new Map(current.surfaces.map((surface) => [surface.id, surface]));
    for (const surface of plan.surfaces) {
      const currentSurface = currentById.get(surface.id);
      if (!currentSurface || currentSurface.identity_hash !== surface.identity_hash)
        throw incomplete("Inventoried surface identity changed during erasure", { surface_id: surface.id });
    }
    if (!(await this.guard.revoked(plan.source.id, plan.source.hash)))
      throw incomplete("Revocation barrier is missing");
    if (plan.request.action === "revoke") {
      for (const surface of plan.surfaces)
        if (!(await this.store.exists(this.impactPath(plan.source.id, surface.id))) ||
          await this.store.readText(this.impactPath(plan.source.id, surface.id)) !== `${JSON.stringify(revocationInvalidation(plan, surface), null, 2)}\n`)
          throw incomplete("Revocation impact was not materialized", { surface_id: surface.id });
      return { inventory_hash: artifactHash(current), verified_surface_ids: [...plannedIds].sort() };
    }
    for (const surface of plan.surfaces) {
      if (surface.strategy === "purge") {
        if (await this.store.exists(surface.path)) throw incomplete("Prohibited local copy remains", { surface_id: surface.id });
      } else if (surface.strategy === "tombstone") {
        const expected = `${canonicalJson(minimalTombstone({ source: plan.source, surface, decision: plan.decision, jobId: plan.job_id }))}\n`;
        if (!(await this.store.exists(surface.path)) || await this.store.readText(surface.path) !== expected)
          throw incomplete("Required minimized tombstone is missing or drifted", { surface_id: surface.id });
      } else {
        const processor = this.externalProcessors[surface.processor];
        const receipt = plan.external_receipts[surface.id];
        if (!receipt || !(await processor?.verify?.({ objectId: surface.object_id, receipt, source: structuredClone(plan.source) })))
          throw incomplete("External copy deletion is not verified", { surface_id: surface.id });
      }
    }
    return { inventory_hash: artifactHash(current), verified_surface_ids: [...plannedIds].sort() };
  }

  async run(workflowId, jobId) {
    if (!ID.test(workflowId ?? "") || !ID.test(jobId ?? "")) throw invalid("Erasure job identity is invalid");
    const planPath = this.planPath(workflowId, jobId);
    if (!(await this.store.exists(planPath))) throw incomplete("Erasure plan is missing");
    let plan = await this.store.readJson(planPath);
    return this.coordinate(plan.source.id, async () => {
      plan = await this.store.readJson(planPath);
      this.#assertPlan(plan, workflowId, jobId);
      if (!this.authority.verify(plan.decision, plan.impact)) throw denied("Persisted retention decision proof is invalid");
      if (!plan.decision.allowed) return this.store.readJson(this.blockedPath(workflowId, jobId));
      if (typeof this.authority.revalidate !== "function" || !this.authority.revalidate(plan.decision, plan.impact))
        throw denied("Retention decision is no longer authorized under current legal holds");
      if (await this.store.exists(this.receiptPath(workflowId, jobId))) {
        const receipt = await this.store.readJson(this.receiptPath(workflowId, jobId));
        if (typeof this.authority.verifyReceipt !== "function" || !this.authority.verifyReceipt(receipt))
          throw incomplete("Erasure receipt trust proof is invalid");
        const verification = await this.#verify(plan);
        if (receipt.verification_hash !== artifactHash(verification))
          throw incomplete("Completed erasure verification no longer matches every known copy");
        await this.#installBarrier(plan, plan.request.action === "erase" ? "erased" : "revoked");
        plan.state = "completed";
        plan.updated_at = receipt.completed_at;
        await this.store.writeJsonAtomic(planPath, plan);
        const job = await this.jobs.get(jobId);
        if (job.state === "running") await this.jobs.transition(jobId, "completed", { result: receipt, progress: { completed: plan.surfaces.length, total: plan.surfaces.length }, error: null });
        return receipt;
      }
      await this.#installBarrier(plan);
      let job = await this.jobs.get(jobId);
      if (job.state === "queued") job = await this.jobs.transition(jobId, "running");
      else if (job.state !== "running") throw conflict("Erasure job is not runnable", { state: job.state });
      const completed = new Set(plan.completed_surface_ids);
      for (const surface of plan.surfaces) {
        if (completed.has(surface.id)) continue;
        await this.fault({ phase: "before-surface", surface: surface.id, plan: structuredClone(plan) });
        const externalReceipt = await this.#treatSurface(plan, surface);
        await this.fault({ phase: "after-surface-before-checkpoint", surface: surface.id, plan: structuredClone(plan) });
        if (externalReceipt) plan.external_receipts[surface.id] = structuredClone(externalReceipt);
        await this.audit.append(workflowId, {
          actor: plan.decision.authority.actor,
          action: plan.request.action === "erase" ? "erasure.copy-treated" : "revocation.impact-invalidated",
          subject: opaque(surface.id),
          input_hash: plan.source.hash,
          result: surface.strategy,
          policy_version: `${plan.decision.policy.id}@${plan.decision.policy.version}`,
          idempotency_key: `erasure-surface:${jobId}:${surface.id}`,
        });
        await this.fault({ phase: "after-surface-audit-before-checkpoint", surface: surface.id, plan: structuredClone(plan) });
        completed.add(surface.id);
        plan.completed_surface_ids = [...completed].sort();
        plan.state = "purging";
        plan.updated_at = this.clock.now();
        await this.store.writeJsonAtomic(planPath, plan);
        const cancelled = await this.jobs.cancellationPoint(jobId, { phase: "surface-treated", surface_id: surface.id });
        if (cancelled) {
          plan.state = "cancelled";
          await this.store.writeJsonAtomic(planPath, plan);
          return { status: "cancelled", job_id: jobId };
        }
      }
      plan.state = "verifying";
      plan.updated_at = this.clock.now();
      await this.store.writeJsonAtomic(planPath, plan);
      await this.fault({ phase: "before-verification", plan: structuredClone(plan) });
      const receipt = await this.coordinateInventory(async () => {
        const verification = await this.#verify(plan);
        const candidate = {
          api_version: "kdlc.dev/erasure-receipt/v1alpha1",
          job_id: jobId,
          workflow_id: workflowId,
          action: plan.request.action,
          source: structuredClone(plan.source),
          result: plan.request.action === "erase" ? "erased" : "revoked",
          impact_hash: artifactHash(plan.impact),
          decision_hash: artifactHash(plan.decision),
          verification_hash: artifactHash(verification),
          treated: {
            total: plan.surfaces.length,
            by_kind: Object.fromEntries([...new Set(plan.surfaces.map(({ kind }) => kind))].sort().map((kind) => [kind, plan.surfaces.filter((surface) => surface.kind === kind).length])),
          },
          completed_at: this.clock.now(),
        };
        if (typeof this.authority.attestReceipt !== "function") throw denied("Erasure receipt authority is unavailable");
        candidate.proof = this.authority.attestReceipt(candidate);
        await this.audit.append(workflowId, {
          actor: plan.decision.authority.actor,
          action: plan.request.action === "erase" ? "erasure.completed" : "source.revocation-completed",
          subject: opaque(plan.source.id),
          input_hash: artifactHash(plan.impact),
          receipt_hash: artifactHash(candidate),
          result: candidate.result,
          policy_version: `${plan.decision.policy.id}@${plan.decision.policy.version}`,
          idempotency_key: `erasure-complete:${jobId}`,
        });
        await this.fault({ phase: "after-audit-before-receipt", plan: structuredClone(plan), receipt: structuredClone(candidate) });
        const finalVerification = await this.#verify(plan);
        if (artifactHash(finalVerification) !== candidate.verification_hash)
          throw incomplete("Erasure inventory changed before receipt commit");
        await this.store.writeJsonAtomic(this.receiptPath(workflowId, jobId), candidate);
        return candidate;
      });
      await this.fault({ phase: "after-receipt-before-finalization", plan: structuredClone(plan), receipt: structuredClone(receipt) });
      await this.#installBarrier(plan, plan.request.action === "erase" ? "erased" : "revoked");
      plan.state = "completed";
      plan.updated_at = receipt.completed_at;
      await this.store.writeJsonAtomic(planPath, plan);
      job = await this.jobs.get(jobId);
      if (job.state === "running") await this.jobs.transition(jobId, "completed", {
        result: receipt,
        progress: { completed: plan.surfaces.length, total: plan.surfaces.length },
        error: null,
      });
      return receipt;
    });
  }

  async issueGovernanceEvidence(workflowId, jobId) {
    const receipt = await this.run(workflowId, jobId);
    if (receipt?.result !== "erased") throw denied("Only completed erasure can produce governance evidence");
    const plan = await this.store.readJson(this.planPath(workflowId, jobId));
    this.#assertPlan(plan, workflowId, jobId);
    return this.authority.issueGovernanceEvidence({ receipt, decision: plan.decision, impact: plan.impact });
  }
}
