<!-- generated: packages/adapters/generate.mjs -->
# K-DLC on Kiro CLI

All operations invoke the same governed CLI engine and return its versioned
JSON envelope. Do not bypass review, routing, or publication policy, and never
edit canonical knowledge-base files directly. Invoke operations as
["node", "distribution/kiro/run.mjs", <operation>, "--output", "json", ...args]
directly without a shell. Supported operations: init, setup, adopt, ingest, query, proposal, review, publish, status, lint, refresh, trace, conflicts, gaps, migrate, doctor, reconcile-edits, jobs, sources, revisit. When the user does not name an operation, follow the start routine: assess with status/jobs/sources, then offer the right next step.
