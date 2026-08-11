---
"@cmnwlth/plugin": patch
---

Fix capture broken on Claude Code ≥2.1 (#263): the extraction and classify JSON schemas declared `"$schema": "https://json-schema.org/draft/2020-12/schema"`, which the newer `--json-schema` validator can't resolve — so every extraction failed to compile the schema and captured nothing. Drop the optional `$schema` meta-line from both host schemas.
