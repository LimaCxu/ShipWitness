# Project portfolio

Each ShipWitness workspace can contain multiple independently configured products or repositories. The project switcher in the top bar controls which project's acceptance contracts, run history, evidence dashboard, and connection settings are shown.

The adjacent **Project portfolio** opens a workspace-wide release view. Its state is derived from persisted runs, evidence verdicts, release decisions, and open rework items. It never asks a language model to infer whether a project is safe to release.

The portfolio distinguishes projects that are approved, awaiting approval, running, queued, failed, held, missing evidence, or not yet started. Each card can open the project directly; projects with runs can open the latest task and its evidence in one step.

## Selection behavior

- Creating or importing a project selects it for the current member.
- Each member has an independent selection in each workspace.
- Refreshing the page preserves that selection.
- Opening a `?run=<run-id>` link selects the run's project before opening its task detail.
- Opening a `?project=<project-id>` link selects that project and then removes the temporary query parameter.
- A missing or stale preference safely falls back to the most recently updated visible project.

Project selection never grants access. Every selection is validated against the authenticated member's current workspace, and removing a member also removes that member's stored preference for the workspace.
