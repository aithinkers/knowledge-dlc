---
name: kdlc-visualize
description: Run the governed K-DLC visualize operation
user-invocable: true
---

**When to use:** You want to see the knowledge base as a map — every published concept and its relationships on one self-contained page.

**What you give it:** Nothing — it reads the published retrieval catalog.

**What you get back:** knowledge/<base>/viz.html: an interactive graph (reviewed titles, descriptions, status, access) that opens in any browser with no dependencies.

**Usually next:** Open the file in a browser; publish more concepts and re-run to refresh it.

Interpret the user arguments as a JSON string array and invoke ["node", "distribution/kiro-ide/run.mjs", "visualize", "--output", "json", "--host-args-json", <arguments-json>] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
