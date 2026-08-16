<!-- generated: packages/adapters/generate.mjs -->
# K-DLC Claude Code commands

All operations invoke the same governed CLI engine. The slash-command palette
carries the human tier only — /kdlc:start, /kdlc:init, /kdlc:ingest,
/kdlc:query, /kdlc:publish, /kdlc:revisit, /kdlc:status, /kdlc:doctor. The
rows below document the FULL operation → CLI mapping; operations without a
palette entry are invoked through the governed runner
(distribution/claude-code/run.mjs), which is how the kdlc agents drive them.

- /kdlc:init → `kdlc init --output json`
- /kdlc:setup → `kdlc setup --output json`
- /kdlc:adopt → `kdlc adopt --output json`
- /kdlc:ingest → `kdlc ingest --output json`
- /kdlc:query → `kdlc query --output json`
- /kdlc:proposal → `kdlc proposal --output json`
- /kdlc:review → `kdlc review --output json`
- /kdlc:publish → `kdlc publish --output json`
- /kdlc:status → `kdlc status --output json`
- /kdlc:lint → `kdlc lint --output json`
- /kdlc:refresh → `kdlc refresh --output json`
- /kdlc:trace → `kdlc trace --output json`
- /kdlc:conflicts → `kdlc conflicts --output json`
- /kdlc:gaps → `kdlc gaps --output json`
- /kdlc:migrate → `kdlc migrate --output json`
- /kdlc:doctor → `kdlc doctor --output json`
- /kdlc:reconcile-edits → `kdlc reconcile-edits --output json`
- /kdlc:jobs → `kdlc jobs --output json`
- /kdlc:sources → `kdlc sources --output json`
- /kdlc:revisit → `kdlc revisit --output json`
