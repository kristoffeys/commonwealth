---
"@cmnwlth/curate": patch
"@cmnwlth/mcp": patch
---

The MCP `remember` tool now files a note from a linked source under its alias-map project, like CLI capture already did. The link moved into `curate`, which every capture path goes through, so a source listed in `projects.json` no longer creates an `<owner>-<repo>/` folder.
