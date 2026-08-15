#!/usr/bin/env node
import {
  createLocalProjectEngine,
  KdlcEngine,
  parseCli,
  renderEnvelope,
  EXIT,
} from "./index.mjs";
let parsed;
try {
  parsed = parseCli(process.argv.slice(2));
  const envelope = await createLocalProjectEngine().envelope(
    parsed.operation,
    parsed.input,
  );
  process.stdout.write(renderEnvelope(envelope, parsed.output));
  process.exitCode = envelope.ok ? EXIT.success : envelope.error.class;
} catch (error) {
  const engine = new KdlcEngine();
  const envelope = await engine.envelope("cli", { error: error.message });
  envelope.error = {
    code: error.code ?? "KDLC_INPUT_INVALID",
    message: error.message,
    class: error.exitClass ?? EXIT.input,
    details: {},
  };
  const requested =
    parsed?.output ??
    (process.argv.includes("--output") &&
    process.argv[process.argv.indexOf("--output") + 1] === "json"
      ? "json"
      : "text");
  process.stderr.write(renderEnvelope(envelope, requested));
  process.exitCode = envelope.error.class;
}
