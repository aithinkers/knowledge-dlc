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
