# De-vendor pre-flight decision

- requestId patch: DROP. devlog-mcp never sends CancelledNotification;
  spec keeps requestId required; patch-package can't reach published
  consumers. Stock @modelcontextprotocol/sdk behavior accepted.
- Baseline suite: green (see Step 1 output).
- Rewire surface: 31 type-importers, 4 server/client importers (verified).
