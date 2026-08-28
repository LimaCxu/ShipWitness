# Email notifications

Email is optional and disabled by default. ShipWitness continues to provide one-time invitation links and the team inbox when SMTP is not configured.

## Configuration

Set both `SHIPWITNESS_SMTP_HOST` and `SHIPWITNESS_SMTP_FROM` to enable delivery. Common optional settings are shown in `.env.example`. Production deployments should also set `SHIPWITNESS_PUBLIC_URL` to the external HTTPS origin so invitation and task links are usable outside the server.

SMTP credentials remain in the deployment environment and are never returned by an API or stored in the ShipWitness database. TLS is required by default. Set `SHIPWITNESS_SMTP_REQUIRE_TLS=false` only for a trusted local relay with a separately reviewed network boundary.

## Events

ShipWitness queues email for:

- one-time workspace invitations when a public URL is configured;
- failed acceptance runs, sent to workspace owners and approvers;
- passed acceptance runs awaiting a release decision, sent to workspace owners and approvers;
- an owner-triggered configuration test.

## Delivery safety

Message bodies are encrypted at rest with `SHIPWITNESS_MASTER_KEY`. This matters for invitation messages because their one-time link contains the only usable copy of the invitation token. Delivery-list APIs never expose encrypted bodies or full recipient addresses.

Workers claim messages atomically, reclaim interrupted sends after five minutes, and retry with exponential backoff. Six failed attempts mark a delivery terminally failed, append an audit event, and create an owner inbox item. Owners can manually retry a terminal failure from **工作区管理 → 邮件通知**.

Delivered and terminally failed records follow the workspace operational-data retention policy. Audit events remain preserved.
