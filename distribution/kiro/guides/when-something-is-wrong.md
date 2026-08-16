<!-- generated: packages/adapters/generate.mjs -->
# When something looks wrong

Start with **kdlc doctor**: it inspects the project, explains problems in
plain terms, and applies only repairs that are safe. **kdlc lint** lists
findings without changing anything, if you want to look before touching.

Reading a failure message: every command reports the same way — what didn't
happen, what it means for you, and whether retrying is safe. Add
`--output human` to any command for the plain-language form.

Three rules that keep trouble small:

- Never hand-edit files under `knowledge-bases/` — the guard hook will stop
  the attempt, and **kdlc reconcile-edits** exists for edits that already
  happened.
- A failed publish or review changes nothing; the governed state is protected
  by design.
- After upgrading K-DLC, run **kdlc migrate** before anything else.
