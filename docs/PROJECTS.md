# Project portfolio

Each ShipWitness workspace can contain multiple independently configured products or repositories. The project switcher in the top bar controls which project's acceptance contracts, run history, evidence dashboard, and connection settings are shown.

## Selection behavior

- Creating or importing a project selects it for the current member.
- Each member has an independent selection in each workspace.
- Refreshing the page preserves that selection.
- Opening a `?run=<run-id>` link selects the run's project before opening its task detail.
- Opening a `?project=<project-id>` link selects that project and then removes the temporary query parameter.
- A missing or stale preference safely falls back to the most recently updated visible project.

Project selection never grants access. Every selection is validated against the authenticated member's current workspace, and removing a member also removes that member's stored preference for the workspace.
