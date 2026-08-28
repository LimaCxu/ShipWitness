# Workspace administration

## Member lifecycle

Owners manage members under **工作区管理 → 成员与角色**.

- Adding a new email creates a user with the supplied initial password. Share it through a separate secure channel.
- Adding an email that already has a ShipWitness account grants workspace membership without changing that user's password.
- Owners can assign `member`, `approver`, or `owner`.
- A workspace must always retain at least one owner. The API rejects removal or demotion of the last owner.
- Removing a member immediately removes the membership, revokes every session for that user in the workspace, and revokes active workspace API keys created by that user. Historical audit events and authored records remain intact.
- Removing a user from one workspace does not remove their memberships or sessions in other workspaces.

## Password changes

Every signed-in user can change their own password under **工作区管理 → 账户安全**. The current password is required. A successful change keeps the requesting session and revokes every other session for that user, including sessions in other workspaces.

ShipWitness does not currently send email or provide unauthenticated password reset. A lost-password recovery procedure requires a controlled operator action and is deliberately not exposed as a public endpoint in development releases.

## Operations summary

Owners and approvers see live workspace counts for queued, running, failed, and stale acceptance runs; pending and failed Webhook deliveries; active storage; and audit-chain integrity. These are operational signals, not an external monitoring system. Production deployments should additionally alert on `/api/health`, container health, PostgreSQL health, disk capacity, backup age, and reverse-proxy errors.
