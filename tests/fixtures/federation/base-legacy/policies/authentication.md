---
type: Policy
title: Legacy Authentication
description: Legacy clients permit password authentication.
status: stable
access: { classification: internal, compartments: [engineering] }
verified: { by: process:legacy-check, at: 2026-08-01T00:00:00Z }
stale_after: 2027-01-01
relationships:
  - { type: contradicting, target: "kb://acme.primary/policies/authentication", applicability: "legacy clients" }
---
Authentication permits passwords for legacy clients.
