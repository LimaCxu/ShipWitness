# Workspace invitations

## Owner workflow

Owners enter the intended email, role, and a validity period of 24 hours, 3 days, or 7 days under **成员与角色**. ShipWitness returns the invitation URL once. Only a SHA-256 hash and the final six-character suffix are stored; the original token cannot be recovered later.

Creating another active invitation for the same workspace and email revokes the older invitation. Owners can also revoke a pending invitation explicitly. Accepted, revoked, and expired invitations remain visible as status history until they become eligible under the workspace operational-data retention policy.

## Recipient workflow

The link reveals only the workspace name, masked destination email, assigned role, expiry, and whether the address already has an account.

- A new user supplies their name and chooses a password of 10 to 128 characters.
- An existing user supplies their current account password. ShipWitness adds the workspace membership without replacing the password.

Successful acceptance consumes the invitation atomically, creates a seven-day HttpOnly SameSite session for that workspace, and appends `invitation.accepted` to the workspace audit chain. Reuse, expiry, and revocation return HTTP 410 without disclosing why the token is invalid.

Invitation URLs are bearer credentials until used. Send them through an access-controlled channel and avoid copying them into issue trackers, logs, analytics, or screenshots.
