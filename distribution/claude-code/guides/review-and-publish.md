<!-- generated: packages/adapters/generate.mjs -->
# Reviewing and publishing

Proposals become knowledge only through an accountable decision. Two reviews
guard the door:

- The **trust-reviewer** asks: is the evidence really there, from where it
  claims, and fresh enough to act on?
- The **governance-reviewer** asks: is publishing this allowed — policy,
  privacy, rights, access level?

Run **kdlc review** with your decision and reasons. The decision binds to the
exact packet you reviewed (its review hash), so what was approved is provable
later. A comment, a chat message, or a thumbs-up is never an approval.

Once approvals are in place, **kdlc publish** makes the content visible at
its access level — and refuses, with the reason, if anything required is
missing. The audit trail is always available through **kdlc trace**.

If a review requests changes, rework the proposal with **kdlc proposal** and
resubmit; the cycle is normal, not a failure.
