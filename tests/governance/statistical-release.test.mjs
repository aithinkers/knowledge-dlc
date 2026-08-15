import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { answerMatchesAccepted, canonicalAnswer, loadPreregistration, providerRequestBytes, scoreCaptures, sha256, validateCandidatePreregistration, validateCapture, validateGoldSemantics, validateScorerBinding, validateStatisticalEvidence, wilsonLower } from "../../scripts/statistical-evidence-validation.mjs";

const root = resolve(import.meta.dirname, "../..");
const execute = promisify(execFile);
async function perfectCapture(index, evidenceRoot = root) {
  const state = await loadPreregistration(evidenceRoot);
  const trial_id = `trial-${String(index).padStart(3, "0")}`;
  const results = state.documents.corpus.cases.map((entry, item) => {
    const expected = state.documents.gold.cases[item].expected;
    const response = { decision: expected.decision, answer: expected.decision === "answer" ? expected.assertions.map(({ object }) => object).join(" ") : "", assertions: expected.assertions, citations: expected.citations }; const raw_output = JSON.stringify(response);
    const request = providerRequestBytes(state, { input: entry.input, context: entry.context });
    return { case_key: entry.case_key, provider_request_id: `provider-${index}-${item}`, request, request_hash: sha256(request), response, raw_output, raw_output_hash: sha256(raw_output) };
  });
  return { api_version: "kdlc.dev/statistical-capture/v1alpha1", trial_id, captured_at: "2026-08-15T12:00:00Z", corpus_hash: state.hashes.corpus, evaluator_gold_hash: state.hashes.gold, profile_hash: state.hashes.profile, manifest_hashes: state.documents.profile.manifest_hashes, results, exclusions: [] };
}

test("REL-002 preregistered 30-trial full-corpus statistical evidence stays exact after the frozen capture", async () => {
  const state = await loadPreregistration(root); const status = JSON.parse(await readFile(resolve(root, "distribution/release/statistical/capture-status.json"), "utf8"));
  assert.equal(state.documents.profile.required_trials, 30); assert.equal(state.documents.corpus.cases.length, 12);
  assert.deepEqual(state.documents.profile.exclusions, { allowed: false, post_hoc: false }); assert.equal(state.documents.model.status, "frozen");
  assert.deepEqual(state.documents.model.configuration, { provider: "anthropic", model: "claude-sonnet-5", revision: "claude-sonnet-5", temperature: 0, seed: 421 });
  assert.equal(state.documents.profile.scorer.sha256, state.hashes.scorer);
  const substituted = structuredClone(state.documents.profile); substituted.scorer.sha256 = `sha256:${"0".repeat(64)}`;
  await assert.rejects(validateScorerBinding(root, substituted), /exact-bind/);
  assert.deepEqual({ status: status.status, captured: status.captured_trials }, { status: "qualified", captured: 30 });
  const evidence = await validateStatisticalEvidence(root);
  assert.deepEqual(evidence, { phase: "qualified", failures: [] });
});

test("REQ-EVAL-001 provider requests contain only public projections and never evaluator gold or semantic labels", async () => {
  const state = await loadPreregistration(root);
  for (const entry of state.documents.corpus.cases) {
    const request = providerRequestBytes(state, { input: entry.input, context: entry.context });
    const parsed = JSON.parse(request);
    assert.deepEqual(Object.keys(parsed), ["api_version", "case", "prompt", "tool", "model"]);
    assert.deepEqual(Object.keys(parsed.case), ["input", "context"]);
    for (const forbidden of ["expected", "required_terms", "required_answer_phrases", "accepted_answers", "security_gate", "category", "case_key", "trial_id", "profile_hash", "evaluator_gold_hash"]) assert.equal(request.includes(`\"${forbidden}\"`), false, forbidden);
    assert.equal(request.includes(JSON.stringify(state.documents.gold)), false);
  }
  const restrictedRequest = JSON.parse(providerRequestBytes(state, { input: state.documents.corpus.cases[4].input, context: state.documents.corpus.cases[4].context }));
  assert.equal(restrictedRequest.case.context.evidence[0].classification, "confidential");
  assert.deepEqual(restrictedRequest.case.context.principal.access_labels, ["public"]);
  const readiness = await readFile(resolve(root, "docs/release-readiness.md"), "utf8");
  assert.match(readiness, /synthetic test data/); assert.match(readiness, /explicitly approved for that\s+external statistical route/);
  const first = state.documents.corpus.cases[0]; const baseline = providerRequestBytes(state, { input: first.input, context: first.context });
  const mutatedGold = structuredClone(state.documents.gold); mutatedGold.cases[0].expected.accepted_answers = ["90 days"];
  const mutatedGoldHash = sha256(`${JSON.stringify(mutatedGold)}\n`); const mutatedProfile = structuredClone(state.documents.profile); mutatedProfile.evaluator_gold_hash = mutatedGoldHash;
  assert.notEqual(mutatedGoldHash, state.hashes.gold); assert.notEqual(sha256(`${JSON.stringify(mutatedProfile)}\n`), state.hashes.profile);
  assert.equal(providerRequestBytes(state, { input: first.input, context: first.context }), baseline);
  const changedContext = structuredClone(first.context); changedContext.trusted_query_time = "2026-08-16T12:00:00Z";
  assert.notEqual(providerRequestBytes(state, { input: first.input, context: changedContext }), baseline);
});

test("REQ-EVAL-001 request construction rejects full cases, nested evaluator keys, accessors, and toJSON hooks", async () => {
  const state = await loadPreregistration(root); const first = state.documents.corpus.cases[0];
  assert.throws(() => providerRequestBytes(state, first), /public provider projection/);
  const nested = structuredClone({ input: first.input, context: first.context }); nested.context.expected = { decision: "answer" };
  assert.throws(() => providerRequestBytes(state, nested), /public provider projection|evaluator-only/);
  const accessor = { context: first.context }; Object.defineProperty(accessor, "input", { enumerable: true, get() { throw new Error("getter executed"); } });
  assert.throws(() => providerRequestBytes(state, accessor), /accessor/);
  const hooked = { input: first.input, context: first.context, toJSON() { return state.documents.gold; } };
  assert.throws(() => providerRequestBytes(state, hooked), /executable/);
});

test("REQ-EVAL-001 prompt, capture, gold, and corpus share the strict response and per-kind locator contract", async () => {
  const state = await loadPreregistration(root); const validateResponse = state.ajv.getSchema("https://kdlc.dev/schemas/release/statistical-response-1.json");
  const expected = state.documents.gold.cases[0].expected;
  const valid = { decision: "answer", answer: "30 days", assertions: expected.assertions, citations: expected.citations };
  assert.equal(validateResponse(valid), true);
  const crossKind = structuredClone(valid); Object.assign(crossKind.citations[0].locator, { table: "retention", row: 1, column: 1 });
  assert.equal(validateResponse(crossKind), false);
  const emptyAssertion = structuredClone(valid); emptyAssertion.assertions[0].object = "";
  assert.equal(validateResponse(emptyAssertion), false);
  const emptyLocator = structuredClone(valid); emptyLocator.citations[0].locator.section = "";
  assert.equal(validateResponse(emptyLocator), false);
  assert.deepEqual(state.documents.prompt.configuration.response_schema, JSON.parse(await readFile(resolve(root, "core/schemas/release/statistical-response.schema.json"), "utf8")));
});

test("REQ-EVAL-001 evaluator gold rejects missing decisive public evidence and misaligned keys", async () => {
  const state = await loadPreregistration(root);
  const validateGold = state.ajv.getSchema("https://kdlc.dev/schemas/release/statistical-gold-1.json"); const multipleAnswers = structuredClone(state.documents.gold); multipleAnswers.cases[0].expected.accepted_answers.push("thirty days"); assert.equal(validateGold(multipleAnswers), false);
  const missing = structuredClone(state.documents.corpus); missing.cases[0].context.evidence = [];
  assert.throws(() => validateGoldSemantics(missing, state.documents.gold), /current authorized evidence/);
  const reordered = structuredClone(state.documents.gold); [reordered.cases[0], reordered.cases[1]] = [reordered.cases[1], reordered.cases[0]];
  assert.throws(() => validateGoldSemantics(state.documents.corpus, reordered), /aligned/);
  const fakeLocator = structuredClone(state.documents.gold); fakeLocator.cases[7].expected.citations[0].locator = { kind: "section", document: "retention.xlsx", section: "table" };
  assert.throws(() => validateGoldSemantics(state.documents.corpus, fakeLocator), /citation lacks/);
});

test("REQ-EVAL-001 every policy scenario fails closed when its decisive public fact is removed", async () => {
  const state = await loadPreregistration(root);
  const mutations = [
    (corpus) => corpus.cases[1].context.evidence.pop(),
    (corpus) => { corpus.cases[2].context.evidence[0].valid_until = null; },
    (corpus) => corpus.cases[3].context.entities.pop(),
    (corpus) => { corpus.cases[4].context.evidence[0].permitted_labels = ["public"]; },
    (corpus) => { corpus.cases[5].context.evidence[0].contains_untrusted_instruction = false; },
    (corpus) => { corpus.cases[6].context.policy.complete_evidence_set = false; },
    (corpus) => { corpus.cases[7].context.evidence[0].normalized_source_hash = null; },
    (corpus) => { corpus.cases[8].context.evidence[0].revocation.state = "active"; },
    (corpus) => { corpus.cases[9].context.evidence[0].language = "en"; },
    (corpus) => { corpus.cases[10].context.evidence[0].permitted_labels = ["public"]; },
    (corpus) => { corpus.cases[11].context.artifact.current_hash = corpus.cases[11].context.artifact.approved_hash; },
  ];
  for (const mutate of mutations) { const corpus = structuredClone(state.documents.corpus); mutate(corpus); assert.throws(() => validateGoldSemantics(corpus, state.documents.gold)); }
});

test("REL-001 trusted preregistration permits the frozen-model transition but rejects a substituted hash chain", async (context) => {
  // The live repo's manifest is frozen; reconstruct the awaiting trusted base in a sandbox.
  const trusted = await mkdtemp(resolve(tmpdir(), "kdlc-awaiting-model-")); context.after(() => rm(trusted, { recursive: true, force: true }));
  await cp(resolve(root, "core"), resolve(trusted, "core"), { recursive: true });
  await cp(resolve(root, "distribution/release/statistical"), resolve(trusted, "distribution/release/statistical"), { recursive: true });
  await mkdir(resolve(trusted, "scripts")); await cp(resolve(root, "scripts/statistical-evidence-validation.mjs"), resolve(trusted, "scripts/statistical-evidence-validation.mjs"));
  const trustedModelPath = resolve(trusted, "distribution/release/statistical/model-manifest.json");
  const trustedModel = JSON.parse(await readFile(trustedModelPath, "utf8"));
  Object.assign(trustedModel, { id: "provider-selection-pending", status: "awaiting-provider-inputs", configuration: { provider: null, model: null, revision: null, temperature: 0, seed: 421 } });
  const trustedModelBytes = `${JSON.stringify(trustedModel, null, 2)}\n`; await writeFile(trustedModelPath, trustedModelBytes);
  const trustedProfilePath = resolve(trusted, "distribution/release/statistical/profile.json");
  const trustedProfile = JSON.parse(await readFile(trustedProfilePath, "utf8")); trustedProfile.manifest_hashes.model = sha256(trustedModelBytes);
  await writeFile(trustedProfilePath, `${JSON.stringify(trustedProfile, null, 2)}\n`);
  const candidate = await mkdtemp(resolve(tmpdir(), "kdlc-frozen-model-")); context.after(() => rm(candidate, { recursive: true, force: true }));
  await cp(trusted, candidate, { recursive: true });
  const modelPath = resolve(candidate, "distribution/release/statistical/model-manifest.json");
  const profilePath = resolve(candidate, "distribution/release/statistical/profile.json");
  const model = JSON.parse(await readFile(modelPath, "utf8"));
  Object.assign(model, { id: "approved-provider-model", status: "frozen", configuration: { provider: "provider.example", model: "model-1", revision: "2026-08-15", temperature: 0, seed: 421 } });
  const modelBytes = `${JSON.stringify(model, null, 2)}\n`; await writeFile(modelPath, modelBytes);
  const profile = JSON.parse(await readFile(profilePath, "utf8")); profile.manifest_hashes.model = sha256(modelBytes); await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  assert.equal((await validateCandidatePreregistration(trusted, candidate)).documents.model.status, "frozen");
  profile.manifest_hashes.model = `sha256:${"0".repeat(64)}`; await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  await assert.rejects(loadPreregistration(candidate), /exact-bind preregistered corpus\/manifests/);
});

test("REL-001 trusted profile comparison rejects threshold, seed, trial, exclusion, and scorer substitutions", async (context) => {
  for (const mutation of ["threshold", "seed", "trials", "exclusions", "scorer"]) {
    const candidate = await mkdtemp(resolve(tmpdir(), `kdlc-profile-${mutation}-`)); context.after(() => rm(candidate, { recursive: true, force: true }));
    await cp(resolve(root, "core"), resolve(candidate, "core"), { recursive: true });
    await cp(resolve(root, "distribution/release/statistical"), resolve(candidate, "distribution/release/statistical"), { recursive: true });
    await mkdir(resolve(candidate, "scripts")); await cp(resolve(root, "scripts/statistical-evidence-validation.mjs"), resolve(candidate, "scripts/statistical-evidence-validation.mjs"));
    const modelPath = resolve(candidate, "distribution/release/statistical/model-manifest.json"); const profilePath = resolve(candidate, "distribution/release/statistical/profile.json");
    const model = JSON.parse(await readFile(modelPath, "utf8")); const profile = JSON.parse(await readFile(profilePath, "utf8"));
    if (mutation === "threshold") profile.metrics[0].minimum_wilson_lower_bound = 0;
    if (mutation === "trials") profile.required_trials = 1;
    if (mutation === "exclusions") profile.exclusions.allowed = true;
    if (mutation === "scorer") profile.scorer.version = 1;
    if (mutation === "seed") { model.configuration.seed = 7; const bytes = `${JSON.stringify(model, null, 2)}\n`; await writeFile(modelPath, bytes); profile.manifest_hashes.model = sha256(bytes); }
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
    await assert.rejects(validateCandidatePreregistration(root, candidate), undefined, mutation);
  }
});

test("REL-001 qualified lifecycle accepts 30 exact trials and rejects missing captured evidence", async (context) => {
  const candidate = await mkdtemp(resolve(tmpdir(), "kdlc-qualified-")); context.after(() => rm(candidate, { recursive: true, force: true }));
  await cp(resolve(root, "core"), resolve(candidate, "core"), { recursive: true }); await cp(resolve(root, "distribution/release/statistical"), resolve(candidate, "distribution/release/statistical"), { recursive: true });
  await mkdir(resolve(candidate, "scripts")); await cp(resolve(root, "scripts/statistical-evidence-validation.mjs"), resolve(candidate, "scripts/statistical-evidence-validation.mjs"));
  const modelPath = resolve(candidate, "distribution/release/statistical/model-manifest.json"); const profilePath = resolve(candidate, "distribution/release/statistical/profile.json");
  const model = JSON.parse(await readFile(modelPath, "utf8")); Object.assign(model, { id: "approved-provider-model", status: "frozen", configuration: { provider: "provider.example", model: "model-1", revision: "2026-08-15", temperature: 0, seed: 421 } });
  const modelBytes = `${JSON.stringify(model, null, 2)}\n`; await writeFile(modelPath, modelBytes); const profile = JSON.parse(await readFile(profilePath, "utf8")); profile.manifest_hashes.model = sha256(modelBytes); await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  const capturesPath = resolve(candidate, "distribution/release/statistical/captures"); await mkdir(capturesPath, { recursive: true });
  const captures = []; for (let index = 1; index <= 30; index += 1) { const capture = await perfectCapture(index, candidate); captures.push(capture); await writeFile(resolve(capturesPath, `${capture.trial_id}.json`), `${JSON.stringify(capture)}\n`); }
  const report = await scoreCaptures(candidate, captures); const reportBytes = `${JSON.stringify(report)}\n`; await writeFile(resolve(candidate, "distribution/release/statistical/report.json"), reportBytes);
  const status = { api_version: "kdlc.dev/statistical-capture-status/v1alpha1", status: "qualified", reason: "Thirty complete provider trials passed the preregistered gate.", required_trials: 30, required_full_corpus_cases_per_trial: 12, captured_trials: 30, exclusions_allowed: false, captures_path: "distribution/release/statistical/captures", report_path: "distribution/release/statistical/report.json", report_hash: sha256(reportBytes) };
  await writeFile(resolve(candidate, "distribution/release/statistical/capture-status.json"), `${JSON.stringify(status, null, 2)}\n`);
  assert.deepEqual(await validateStatisticalEvidence(candidate), { phase: "qualified", failures: [] });
  await rm(resolve(capturesPath, "trial-030.json")); assert.equal((await validateStatisticalEvidence(candidate)).phase, "invalid");
});

test("REL-001 protected matrix-cell release command accepts a coherent qualified candidate precheck", async (context) => {
  const candidate = await mkdtemp(resolve(tmpdir(), "kdlc-qualified-command-")); context.after(() => rm(candidate, { recursive: true, force: true }));
  for (const path of ["core", "distribution", "docs", "packages", "scripts", "tests"]) { await mkdir(resolve(candidate, path, ".."), { recursive: true }); await cp(resolve(root, path), resolve(candidate, path), { recursive: true }); }
  await cp(resolve(root, "package.json"), resolve(candidate, "package.json")); await cp(resolve(root, "package-lock.json"), resolve(candidate, "package-lock.json"));
  const modelPath = resolve(candidate, "distribution/release/statistical/model-manifest.json"); const profilePath = resolve(candidate, "distribution/release/statistical/profile.json");
  const model = JSON.parse(await readFile(modelPath, "utf8")); Object.assign(model, { id: "approved-provider-model", status: "frozen", configuration: { provider: "provider.example", model: "model-1", revision: "2026-08-15", temperature: 0, seed: 421 } });
  const modelBytes = `${JSON.stringify(model, null, 2)}\n`; await writeFile(modelPath, modelBytes); const profile = JSON.parse(await readFile(profilePath, "utf8")); profile.manifest_hashes.model = sha256(modelBytes); await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  const capturesPath = resolve(candidate, "distribution/release/statistical/captures"); await mkdir(capturesPath, { recursive: true }); const captures = [];
  for (let index = 1; index <= 30; index += 1) { const capture = await perfectCapture(index, candidate); captures.push(capture); await writeFile(resolve(capturesPath, `${capture.trial_id}.json`), `${JSON.stringify(capture)}\n`); }
  const statisticalReport = await scoreCaptures(candidate, captures); const statisticalReportBytes = `${JSON.stringify(statisticalReport)}\n`; await writeFile(resolve(candidate, "distribution/release/statistical/report.json"), statisticalReportBytes);
  await writeFile(resolve(candidate, "distribution/release/statistical/capture-status.json"), `${JSON.stringify({ api_version: "kdlc.dev/statistical-capture-status/v1alpha1", status: "qualified", reason: "Thirty complete provider trials passed the preregistered gate.", required_trials: 30, required_full_corpus_cases_per_trial: 12, captured_trials: 30, exclusions_allowed: false, captures_path: "distribution/release/statistical/captures", report_path: "distribution/release/statistical/report.json", report_hash: sha256(statisticalReportBytes) }, null, 2)}\n`);
  const version = "1.0.0"; const packageDocument = JSON.parse(await readFile(resolve(candidate, "package.json"), "utf8")); packageDocument.version = version; packageDocument.private = false; await writeFile(resolve(candidate, "package.json"), `${JSON.stringify(packageDocument, null, 2)}\n`);
  const lock = JSON.parse(await readFile(resolve(candidate, "package-lock.json"), "utf8")); lock.version = version; lock.packages[""].version = version; await writeFile(resolve(candidate, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  const evaluationPath = resolve(candidate, "distribution/release/evaluation-report.json"); const evaluation = JSON.parse(await readFile(evaluationPath, "utf8")); Object.assign(evaluation, { release_status: "release-candidate", implementation_version: version, statistical_suite: { status: "qualified", release_blocking: false }, pending_release_evidence: [] }); const evaluationBytes = `${JSON.stringify(evaluation, null, 2)}\n`; await writeFile(evaluationPath, evaluationBytes);
  const tracePath = resolve(candidate, "docs/traceability.json"); const trace = JSON.parse(await readFile(tracePath, "utf8")); trace.requirements.find(({ id }) => id === "REL-001").status = "verified"; const traceBytes = `${JSON.stringify(trace, null, 2)}\n`; await writeFile(tracePath, traceBytes);
  const conformancePath = resolve(candidate, "distribution/release/conformance-statement.json"); const conformance = JSON.parse(await readFile(conformancePath, "utf8")); Object.assign(conformance, { release_status: "release-candidate", pending_requirements: [] }); Object.assign(conformance.implementation, { version, private: false });
  for (const item of conformance.evidence) { if (item.path === "distribution/release/evaluation-report.json") item.sha256 = sha256(evaluationBytes); if (item.path === "docs/traceability.json") item.sha256 = sha256(traceBytes); }
  await writeFile(conformancePath, `${JSON.stringify(conformance, null, 2)}\n`); const changelog = `# Changelog\n\n## ${version}\n`; await writeFile(resolve(candidate, "CHANGELOG.md"), changelog);
  await writeFile(resolve(candidate, "distribution/release/release-candidate-evidence.json"), `${JSON.stringify({ api_version: "kdlc.dev/release-candidate-evidence/v1alpha1", version, changelog: { path: "CHANGELOG.md", sha256: sha256(changelog) } }, null, 2)}\n`);
  await execute(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "check:release-evidence"], { cwd: root, env: { ...process.env, KDLC_CANDIDATE_ROOT: candidate, KDLC_RELEASE_MATRIX_PRECHECK: "1" }, ...(process.platform === "win32" ? { shell: true } : {}), maxBuffer: 16 * 1024 * 1024 });
});

test("REL-001 offline scorer derives declared Wilson bounds from all 30 complete trials", async () => {
  const captures = await Promise.all(Array.from({ length: 30 }, (_, index) => perfectCapture(index + 1))); const report = await scoreCaptures(root, captures);
  assert.equal(report.trial_count, 30); assert.equal(report.case_count_per_trial, 12); assert.equal(report.gate, "passed");
  for (const metric of report.metrics) { assert.equal(metric.rate, 1); if (metric.threshold_kind === "wilson-lower-bound") assert.equal(metric.wilson_lower_bound, wilsonLower(metric.successes, metric.observations, 1.959963984540054)); else assert.equal(metric.wilson_lower_bound, undefined); }
});

test("REL-001 capture validation rejects missing cases, substitutions, request drift, raw-output drift, exclusions, and provenance drift", async () => {
  for (const mutation of ["missing", "substitution", "request", "raw", "exclusion", "provenance"]) {
    const capture = await perfectCapture(1);
    if (mutation === "missing") capture.results.pop();
    if (mutation === "substitution") capture.results[0].case_key = capture.results[1].case_key;
    if (mutation === "request") capture.results[0].request = capture.results[1].request;
    if (mutation === "raw") capture.results[0].raw_output = '{"decision":"deny","answer":""}';
    if (mutation === "exclusion") capture.exclusions.push("grounded-source");
    if (mutation === "provenance") capture.model_hash = capture.manifest_hashes.model = `sha256:${"0".repeat(64)}`;
    await assert.rejects(validateCapture(root, capture), undefined, mutation);
  }
});

test("REL-001 scorer rejects cross-trial provider replay and any disclosing security denial", async () => {
  const captures = await Promise.all(Array.from({ length: 30 }, (_, index) => perfectCapture(index + 1)));
  const replayed = structuredClone(captures); replayed[29].results[0].provider_request_id = replayed[0].results[0].provider_request_id;
  await assert.rejects(scoreCaptures(root, replayed), /360 provider request IDs/);
  const leaking = structuredClone(captures); const index = (await loadPreregistration(root)).documents.gold.cases.findIndex(({ security_gate }) => security_gate);
  const response = { ...leaking[0].results[index].response, answer: "confidential source text" }; leaking[0].results[index].response = response;
  leaking[0].results[index].raw_output = JSON.stringify(response); leaking[0].results[index].raw_output_hash = sha256(leaking[0].results[index].raw_output);
  const report = await scoreCaptures(root, leaking); const security = report.metrics.find(({ id }) => id === "security_fail_closed");
  assert.equal(security.passed, false); assert.equal(report.gate, "failed");
});

test("REQ-EVAL-001 scorer gives no grounded credit for wrong decisions, echoed/negated text, or fake locators and exposes systematic case failure", async () => {
  const captures = await Promise.all(Array.from({ length: 30 }, (_, index) => perfectCapture(index + 1)));
  for (const capture of captures) {
    const result = capture.results[0];
    result.response = { decision: "deny", answer: "not 30 days — quoted source says ‘30 days’ ３０ days", assertions: [{ subject: "records", predicate: "retention-period", object: "30 days" }], citations: [{ source_id: "retention-policy", locator: { kind: "section", document: "retention-policy.md", section: "table" } }] };
    result.raw_output = JSON.stringify(result.response); result.raw_output_hash = sha256(result.raw_output);
  }
  const report = await scoreCaptures(root, captures);
  assert.equal(report.metrics.find(({ id }) => id === "grounded_fact_accuracy").successes, 60);
  assert.equal(report.metrics.find(({ id }) => id === "locator_accuracy").successes, 60);
  assert.deepEqual(report.case_results[0], { ...report.case_results[0], successes: 0, rate: 0, passed: false });
  assert.equal(report.gate, "failed");
});

test("REQ-EVAL-001 answer scoring accepts only evaluator-bound canonical answers despite exact structured fields", async () => {
  assert.equal(canonicalAnswer("  30\t days  "), "30 days");
  assert.equal(answerMatchesAccepted("30\t days", ["30 days"]), true);
  assert.equal(answerMatchesAccepted("30 di\u0301as", ["30 días"]), true);
  const adversarial = [
    ["THIS ANSWER IS FALSE AND UNRELATED", "30 days"],
    ["The current policy is not the claim that an obsolete document might describe as 30 days.", "30 days"],
    ["The actual period is 90 days, although one source says 30 days.", "30 days"],
    ["The period is 30 days, but the binding rule requires ninety days.", "30 days"],
    ["not 30 days", "30 days"], ["30 days is false", "30 days"], ["30 dаys", "30 days"], ["30 DAYS", "30 days"],
    ["30 day's", "30 days"], ["30 days'", "30 days"],
    ["no son 30 días", "30 días"], ["aunque una fuente dice 30 días, no es vigente", "30 días"],
  ];
  for (const quote of [["“", "”"], ["‘", "’"], ["«", "»"], ["‹", "›"], ["「", "」"], ["『", "』"], ["《", "》"], ["〝", "〞"]]) adversarial.push([`${quote[0]}30 days${quote[1]}`, "30 days"]);
  for (const [answer, accepted] of adversarial) assert.equal(answerMatchesAccepted(answer, [accepted]), false, answer);

  const fullCaptureMutations = [
    ["The current policy is not the claim that an obsolete document might describe as 30 days.", 0],
    ["The actual period is 90 days, although one source says 30 days.", 7],
    ["«30 días»", 9],
  ];
  for (const [answer, caseIndex] of fullCaptureMutations) {
    const captures = await Promise.all(Array.from({ length: 30 }, (_, index) => perfectCapture(index + 1)));
    for (const capture of captures) {
      const result = capture.results[caseIndex]; result.response.answer = answer; result.raw_output = JSON.stringify(result.response); result.raw_output_hash = sha256(result.raw_output);
    }
    const report = await scoreCaptures(root, captures);
    const facts = report.metrics.find(({ id }) => id === "grounded_fact_accuracy");
    assert.equal(report.case_results[caseIndex].successes, 0, answer);
    assert.equal(report.case_results[caseIndex].passed, false, answer);
    assert.equal(facts.successes, 60, answer);
    assert.equal(facts.passed, false, answer);
    assert.equal(report.gate, "failed", answer);
  }
});

test("REL-001 scorer rejects missing, duplicate, extra, or post-hoc-selected trials", async () => {
  const captures = await Promise.all(Array.from({ length: 30 }, (_, index) => perfectCapture(index + 1)));
  await assert.rejects(scoreCaptures(root, captures.slice(0, 29)), /exactly 30/);
  const duplicate = structuredClone(captures); duplicate[29].trial_id = "trial-029"; await assert.rejects(scoreCaptures(root, duplicate), /trial-001 through trial-030/);
  const selected = structuredClone(captures); selected[0].exclusions = ["stale-source"]; await assert.rejects(scoreCaptures(root, selected), /capture contract/);
});
