# Acceptance starter kits

ShipWitness opens the first-use wizard when a workspace has no project. A starter kit creates three linked, persisted assets in one transaction:

1. the project connection;
2. two enabled, versioned acceptance contracts with deterministic browser assertions;
3. the first queued run with an immutable contract snapshot.

The available kits are:

- **Website** — verifies required page text and a visible page body;
- **Dashboard** — verifies required page text and a visible `main` workspace;
- **Login** — verifies required page text and a visible password input.

The user supplies the repository directory, test URL, same-origin start path, and text that must appear. Starter kits never invent a product-specific result. The server validates the target URL, start path, expected text, and browser steps before writing any asset.

When **run immediately** is enabled, the UI performs the regular project preflight after creation. It executes the queued run only when both the target URL and Chromium runtime are ready. If the environment is not ready, the project and run remain saved and the UI opens the connection panel with the real check results.

The starter flow is also available through the authenticated API:

```text
GET  /api/starter-kits
POST /api/starter-kits/apply
```

Applying a kit appends `starter_kit.applied` to the workspace audit chain with the selected kit, contract count, and first run identifier.
