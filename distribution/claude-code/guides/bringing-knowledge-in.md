<!-- generated: packages/adapters/generate.mjs -->
# Bringing knowledge in

Getting a document, wiki export, or page into the knowledge base is a
pipeline, and nothing you feed it changes published knowledge until it has
been reviewed. The normal path:

1. **kdlc ingest** — hand it the source. It is normalized into evidence with
   provenance: where it came from, which version, when.
2. The **source-analyst** turns evidence into claims, each pinned to the exact
   place in the source it came from and labeled explicit, inferred, or
   computed.
3. The **curator** decides what belongs, guided by the project purpose you
   configured. Borderline calls come back to you as questions.
4. The **integrator** reconciles new claims with what the knowledge base
   already holds — agreements merge, real disagreements stay visible as
   recorded conflicts.
5. What survives becomes a **proposal**. Check on it with **kdlc proposal**;
   nothing publishes without review.

Already-written material that should come under governance wholesale goes
through **kdlc adopt** instead. Watch any long run with **kdlc status** or
**kdlc jobs**.

## Sources that live somewhere else

Documents in Google Drive, OneDrive, SharePoint, or Confluence can be
ingested with their provenance intact. The interactive path: have your
assistant fetch the **original file bytes** (through an MCP server or a
download — never an extracted-text rendering), save them locally, and run
**kdlc ingest** with a remote descriptor (`--remote-json`) naming the
provider, the item's ID, its revision (Drive revision ID, OneDrive/SharePoint
eTag, Confluence version number), how it was acquired, the content hash, and
the source's access sensitivity. K-DLC verifies the hash against the actual
bytes — a transport that delivered different content than it claims is
refused — and records an acquisition receipt you can list with
**kdlc sources**. Those revision identities are what later staleness checks
compare against.
