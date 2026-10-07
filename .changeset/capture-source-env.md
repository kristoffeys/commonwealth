---
"@cmnwlth/core": patch
"@cmnwlth/curate": patch
"@cmnwlth/mcp": patch
---

Captured notes take their `source` from `$COMMONWEALTH_SOURCE` when it is set, so a host that runs every session from one folder (the Relay app runs Claude Code in the vault) can file notes under the project the session is about instead of under the folder's name.
