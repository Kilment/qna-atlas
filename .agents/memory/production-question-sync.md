---
name: Production question sync
description: How to safely propagate corrections to existing question IDs in the live database.
---

Corrections to existing question IDs must go through the published, authenticated admin update path so the live database receives the edit and a `question_revisions` audit row is created. The workspace production database tooling is read-only, and content promotion is insert-only for existing IDs.

**Why:** Development and production can contain the same question ID with different text when an authored correction is made after the original import. Updating an unrelated Neon connection or republishing content without an explicit existing-row update does not repair the live record.

**How to apply:** Confirm the deployment includes the audited admin content-update route, submit the exact approved development question and answer, then query production for the row and its newest revision before reporting success.