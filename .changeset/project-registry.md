---
"@cmnwlth/core": minor
"@cmnwlth/curate": minor
"@cmnwlth/mcp": minor
"@cmnwlth/cli": minor
---

A populated `.commonwealth/projects.json` is now the only thing that names a project folder (ADR-0047). Sources match case-insensitively and `owner/*` matches a whole org; a project can list `names` that a host passes in the new `$COMMONWEALTH_PROJECT`. A note that matches no project waits in the review queue and is promoted with `commonwealth promote <id> --project <id>`; a repo from an org the registry doesn't list is refused (`outside-registry`). `promote --pr` now files under the project like local promote. Brains without a registry behave as before. `project adopt` no longer removes registry entries after stamping (the registry is permanent now), and the `COMMONWEALTH.md` hub links each project's one MOC instead of one link per source.
