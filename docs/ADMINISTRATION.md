# Workspace administration

## Member lifecycle

Owners manage members under **工作区管理 → 成员与角色**.

- The management panel creates a one-time invitation instead of asking the owner to choose a member password. Share the link through a separate secure channel.
- New users choose their own password. Existing ShipWitness users confirm their current password and gain the additional workspace membership without changing credentials.
- Owners can assign `member`, `approver`, or `owner`.
- A workspace must always retain at least one owner. The API rejects removal or demotion of the last owner.
- Removing a member immediately removes the membership, revokes every session for that user in the workspace, and revokes active workspace API keys created by that user. Historical audit events and authored records remain intact.
- Removing a user from one workspace does not remove their memberships or sessions in other workspaces.

Invitation expiry, revocation, replacement, and acceptance behavior is documented in [INVITATIONS.md](INVITATIONS.md). The direct member-creation API remains available for controlled backward compatibility, but the product UI defaults to invitations.

## Password changes

Every signed-in user can change their own password under **工作区管理 → 账户安全**. The current password is required. A successful change keeps the requesting session and revokes every other session for that user, including sessions in other workspaces.

Owners can reset another member's password from **成员与角色 → 重置密码**. The reset revokes every session for that user across all workspaces. The new value is a temporary password: after signing in, the member can read the workspace but cannot perform write operations until they replace it under **账户安全**. Owners cannot use this route for their own account and must provide the temporary password through a separate secure channel.

ShipWitness does not send email and deliberately exposes no unauthenticated reset endpoint in development releases.

## Operations summary

Owners and approvers see live workspace counts for queued, running, failed, and stale acceptance runs; pending and failed Webhook deliveries; active storage; and audit-chain integrity. These are operational signals, not an external monitoring system. Production deployments should additionally alert on `/api/health`, container health, PostgreSQL health, disk capacity, backup age, and reverse-proxy errors.

## Alert lifecycle

Opening the management panel refreshes persisted workspace alerts. ShipWitness raises alerts for audit-chain damage, acceptance runs stuck for more than 15 minutes, failed acceptance runs, and Webhook deliveries that exhausted retries. Owners and approvers can acknowledge an alert; every transition is appended to the audit chain. An active condition cannot be marked resolved manually. After the underlying condition disappears, the next refresh resolves the alert automatically and preserves it in history.

## Audit export and retention

Owners and approvers can generate and download immutable audit snapshots under **合规与数据治理**. Owners can additionally configure and preview operational-data retention before confirming cleanup. The product deliberately excludes acceptance evidence and audit history from automatic deletion. See [DATA_RETENTION.md](DATA_RETENTION.md) for the exact boundary and safe operating procedure.
