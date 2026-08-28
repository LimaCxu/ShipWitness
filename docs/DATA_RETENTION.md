# Data retention and audit export

## Policy boundary

Owners select an operational-data retention period from 30 to 730 days. The policy applies only to expired sessions, terminal Webhook deliveries, resolved alerts, and accepted, revoked, or expired invitations. Active invitations are never eligible. ShipWitness never automatically removes audit events, acceptance runs, issues, release decisions, signed dossiers, or screenshot evidence.

This boundary keeps historical release claims verifiable. Operators who must delete evidence for contractual or legal reasons should export the audit chain, take and verify a backup, document approval outside ShipWitness, and use a separately reviewed procedure.

## Preview and cleanup

The management panel first requests a preview containing the cutoff, per-collection counts, and a token bound to that exact snapshot. Cleanup succeeds only when the same preview is less than ten minutes old and the eligible record counts have not changed. If the data changes, ShipWitness refuses the request and requires a new preview.

Every policy change and successful cleanup appends a hash-chained audit event with the cutoff and deleted counts. Cleanup never runs on a timer in this release; an owner must explicitly review and confirm it.

## Audit exports

Owners and approvers can generate a JSON audit snapshot. Each export contains workspace identity, generation metadata, a public actor directory, all events in sequence order, and the chain-integrity result and head hash at export time. The generated snapshot is stored unchanged and the export action itself is appended as the next audit event.

Treat exported files as sensitive operational records because they contain member names, email addresses, and activity history. Store them with access control and an appropriate external retention policy.
