# Acceptance contract packs

ShipWitness contract packs make executable acceptance standards reusable across projects without changing historical runs. A run always keeps its immutable contract snapshot; importing or editing a standard only affects future runs.

## Reuse workflow

Open the project's contract library and choose **Reuse standards**. You can copy from another project in the current workspace or choose a JSON file exported by ShipWitness. Preview is mandatory in the interface and reports how many standards are new and which codes conflict.

For conflicts, choose one of two explicit policies:

- **Skip:** preserve the target project's current standard and import only new codes.
- **Replace as a new version:** update the target standard's content and increment its version. Existing run snapshots remain unchanged.

Exports use the `shipwitness.contract-pack.v1` schema and omit workspace IDs, project IDs, database IDs, timestamps, and audit metadata. Imports accept at most 100 unique codes, validate every field and browser step, and only operate inside the authenticated workspace.

Bulk enable or disable changes the version of each affected standard. Disabled standards remain in the library but are excluded from newly created runs.
