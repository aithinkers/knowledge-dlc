---
type: Policy
title: Authentication Standard
description: Authentication requires phishing-resistant credentials.
status: stable
access: { classification: internal, compartments: [engineering] }
verified: { by: human:reviewer, at: 2026-08-01T00:00:00Z }
stale_after: 2027-01-01
relationships:
  - { type: contradicting, target: "kb://acme.legacy/policies/authentication", applicability: "legacy clients" }
sources:
  - { id: auth-source, resource: "https://example.invalid/auth", source_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", access: { classification: internal } }
---
Authentication must use phishing-resistant credentials.
