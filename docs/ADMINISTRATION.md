# Workspace administration

## Backup and restore center

PostgreSQL 部署的管理员可以在“工作区设置 → 治理 → 备份与恢复”创建恢复点。每个恢复点包含 PostgreSQL 自定义格式转储、证据文件副本和 SHA-256 清单。只有完成“校验”后，当前运行实例的上线就绪中心才会把最近备份视为已验证。

后台的“恢复预检”只重新校验文件、检查 Schema 兼容性并生成停服恢复命令，不会修改当前数据库。真正恢复必须先停止应用，并优先恢复到独立数据库完成历史任务、截图和签名证据验收；运行中的 HTTP 服务永远不会直接覆盖自己的数据库。

## First deployment

全新实例首次打开时会进入两步部署向导。第一步只展示不含密钥、密码和主机凭据的运行预检：存储引擎、持久化主密钥、HTTPS 公开地址和 SMTP。第二步创建组织空间与首位管理员。初始化时的部署模式与检查摘要会写入工作区和审计链，便于交付复核。

“受控试点”表示可在本机或受控网络继续配置和验证，不代表允许直接暴露公网。“公网候选”也不是正式上线结论；管理员仍需在上线就绪中心完成备份、安全评审、MFA、通知与发布门禁检查。

## Member access and account recovery

工作区管理员可在“工作区管理 → 成员与角色”查看成员状态、在线设备数和 MFA 状态，并执行停用、恢复、强制下线、密码重置或 MFA 重置。停用是工作区级操作：历史验收与审计证据继续保留，但当前工作区会话立即失效，成员在该工作区创建的 API Key 同时撤销。

MFA 属于用户身份而非单个工作区。为避免一个组织影响另一个组织，属于多个工作区的账号不能由单一工作区管理员重置 MFA，必须由账号本人处理。所有管理员安全操作都会写入审计时间线。

## Password recovery

The login page exposes **忘记密码** when setup is complete. A request always returns the same accepted response whether or not the email exists, so the endpoint does not disclose account membership. Delivery requires both SMTP and `SHIPWITNESS_PUBLIC_URL`; otherwise the response remains generic and an owner must use the governed member-reset process.

Each email link is random, stored only as a SHA-256 hash, valid for 30 minutes, and usable once. A newer request revokes older pending links. Completing recovery changes the password, revokes every session and pending MFA challenge for the account, and writes audit events in each joined workspace. Existing TOTP configuration and unused recovery codes remain active, so the next login still requires the second factor.

## Two-step verification

Members can enable TOTP two-step verification under **工作区设置 → 团队 → 账户安全**. Enrollment requires the current password and one valid six-digit code from a standard authenticator. ShipWitness displays ten recovery codes once; each code can complete one login and is removed immediately after use.

After enrollment, a correct password creates only a five-minute verification challenge, not a session. The challenge accepts at most five failed codes. Existing protected accounts must also complete the second factor before accepting a new workspace invitation. Enabling or disabling two-step verification revokes every other session and appends an audit event.

TOTP secrets are AES-256-GCM encrypted with `SHIPWITNESS_MASTER_KEY`. Master-key rotation re-encrypts active and pending TOTP secrets together with signing keys, webhook secrets, and queued email content. Losing both the authenticator and all recovery codes intentionally prevents password-only access; operators must restore access through an independently governed recovery procedure rather than bypassing the second factor.

## Login devices and sessions

Every member can view their own active login devices under **工作区设置 → 团队 → 账户安全**. The list never exposes another member's sessions. It shows a safe browser/platform summary plus login and expiry times.

A member can revoke any non-current device. That device loses access immediately and the action is appended to the workspace audit chain. The current device must use the top-bar **退出** action so an accidental click cannot interrupt active administration work. Changing the password still revokes every other session for the account at once.

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

Optional email notifications do not change password recovery: ShipWitness deliberately exposes no unauthenticated password-reset endpoint or password-reset email in development releases. Owners continue to perform an audited reset and share the temporary password through a separately secured channel.

## Operations summary

Owners and approvers see live workspace counts for queued, running, failed, and stale acceptance runs; pending and failed Webhook deliveries; active storage; and audit-chain integrity. These are operational signals, not an external monitoring system. Production deployments should additionally alert on `/api/health`, container health, PostgreSQL health, disk capacity, backup age, and reverse-proxy errors.

## Alert lifecycle

Opening the management panel refreshes persisted workspace alerts. ShipWitness raises alerts for audit-chain damage, acceptance runs stuck for more than 15 minutes, failed acceptance runs, and Webhook deliveries that exhausted retries. Owners and approvers can acknowledge an alert; every transition is appended to the audit chain. An active condition cannot be marked resolved manually. After the underlying condition disappears, the next refresh resolves the alert automatically and preserves it in history.

## Audit export and retention

Owners and approvers can generate and download immutable audit snapshots under **合规与数据治理**. Owners can additionally configure and preview operational-data retention before confirming cleanup. The product deliberately excludes acceptance evidence and audit history from automatic deletion. See [DATA_RETENTION.md](DATA_RETENTION.md) for the exact boundary and safe operating procedure.
