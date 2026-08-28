# Handoff and integrations

## GitHub repository evidence

Projects may store a GitHub repository identifier in `owner/repository` form. Owners and approvers explicitly choose **同步仓库** in Project Connection; ShipWitness then reads the configured branch, its current commit, combined commit statuses, and latest check runs from fixed `api.github.com` routes. Members can view the cached result but cannot initiate external synchronization.

Every newly created acceptance run, retry, or focused retest copies the latest synchronized repository state into an immutable `repositorySnapshot`. Later pushes or refreshes do not rewrite historical runs. If a run has a repository snapshot, the release gate requires its bound CI state to be `success`; failed, pending, or missing CI evidence remains blocked. Projects without a synchronized repository retain the existing evidence-only workflow for backward compatibility.

Public repositories can be read without a token subject to GitHub rate limits. Private repositories require a server-side fine-grained `GITHUB_TOKEN` with **Contents**, **Commit statuses**, and **Checks** read access. GitHub Issue export additionally needs **Issues** write access. Tokens are never returned to the browser or persisted in project data.

### Automatic synchronization webhook

1. Generate a separate high-entropy secret and set `SHIPWITNESS_GITHUB_WEBHOOK_SECRET` on the ShipWitness server.
2. In the GitHub repository, create a webhook targeting the HTTPS address shown under **工作区管理 → GitHub 自动同步**.
3. Select JSON payloads and use the same secret. Subscribe to **Pushes**, **Check suites**, **Check runs**, and **Workflow runs**.
4. ShipWitness verifies `X-Hub-Signature-256` over the untouched request bytes, persists `X-GitHub-Delivery` before processing, and accepts a delivery ID only once.

Webhook payloads do not directly overwrite repository state. A matching event causes ShipWitness to re-read the configured branch through fixed GitHub API routes, so delayed or out-of-order events converge on the current remote state. Only an exact repository and branch match triggers synchronization. Failed refreshes remain visible to owners and approvers and can be retried without replaying the original external request.

## Coding-agent handoff package

Every persisted rework issue exposes `GET /api/issues/:id/handoff`. The response is a versioned `shipwitness.handoff.v1` JSON object containing the immutable acceptance target, observed result, reproduction steps, evidence references, branch, and a ready-to-use repair prompt.

The package deliberately tells the coding agent not to change the acceptance contract. After repair, ShipWitness creates a focused retest run from the original contract snapshot.

## GitHub Issues

1. Set the project's repository to `owner/repository` in Project Connection.
2. Set its handoff mode to **Create GitHub Issue**.
3. Provide `GITHUB_TOKEN` only in the server environment. Never paste it into the browser UI or store it in project data.
4. Create a rework issue from failed evidence, then choose **Create GitHub Issue**.

ShipWitness calls only `https://api.github.com/repos/<owner>/<repository>/issues`, rejects invalid repository names, refuses duplicate exports, records the returned issue URL on the rework issue, and appends an `issue.exported` audit event. Use a fine-grained token restricted to the selected repository with Issues write access.

GitHub export is an explicit user action. ShipWitness never sends evidence to an external service merely because a run failed.

## API summary

- `GET /api/issues/:id/handoff` — generate a deterministic agent handoff package.
- `POST /api/issues/:id/export/github` — create one linked GitHub Issue.
- `GET /api/projects/:id/repository` — read the cached repository status.
- `POST /api/projects/:id/repository/sync` — explicitly refresh GitHub commit and CI evidence as owner or approver.
- `POST /api/integrations/github/webhook` — receive and verify GitHub events without user-session authentication.
- `GET /api/integrations/github` — view configuration state and workspace-filtered event history.
- `POST /api/github-deliveries/:id/retry` — retry a failed refresh as owner or approver.
- `GET /api/audit` — list workspace audit events for owners and approvers.
- `GET /api/audit/verify` — verify sequence numbers, previous hashes, and event hashes.
- `GET /api/decisions?runId=...` — list release decisions.
- `POST /api/decisions` — record `approve` or `hold`; approval is rejected unless the evidence verdict passed.
