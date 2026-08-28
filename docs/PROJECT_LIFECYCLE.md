# Project lifecycle

ShipWitness uses reversible archival instead of destructive project deletion. Only workspace owners can archive or restore a project, and every archive requires a reason that is preserved in the audit chain.

Archiving removes the project from project switching and the active portfolio. Runs, immutable evidence, contracts, issues, decisions, dossiers, and audit events are retained. The portfolio lists archived projects with their reason, timestamp, run count, and contract count.

## Safety rules

- A project with a queued or running acceptance task cannot be archived.
- Archived projects cannot be selected, edited, preflighted, given new contracts, imported into, or used to create or retry runs.
- If a member currently selected the archived project, ShipWitness moves that personal selection to the most recently updated active project. If none remains, the selection is cleared.
- Restoring a project makes it available for normal work again without changing its historical data.

Archival is not a retention or erasure mechanism. Use the documented retention workflow for eligible operational records; evidence-bearing release records remain preserved by design.
