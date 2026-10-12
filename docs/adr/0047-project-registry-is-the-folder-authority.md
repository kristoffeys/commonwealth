# 47. The project registry is the folder authority

- Status: Accepted
- Date: 2026-10-12
- Deciders: kristof (owner), Claude (orchestrator)
- Amends: [ADR-0031](0031-project-identity-resolved-at-read-time.md) (the alias map becomes the
  write-time registry once it has entries), [ADR-0035](0035-physical-layout-keys-off-resolved-project.md)
  (a populated registry no longer lets a source name a folder)
- Relates: [ADR-0015](0015-note-project-provenance.md) (`source` stays provenance),
  [ADR-0024](0024-rule-based-brain-resolution.md) (which brain; this ADR is which folder inside it)

## Context

A brain's top-level folders came from whatever the session's cwd was: `owner-repo` from a git
origin, else the folder name. The Antenna brain grew 41 top-level folders for about 15 real
projects: `vault/` and `Contexts/` (Relay runs Claude Code in the vault), `infra/`, `k6-tests/` and
`lemahieu-shopware/` (non-git parents or repos without an origin), six `o2o-Bicycle-leasing-*`
folders for one client, and `weareantenna-*` strays the MCP path wrote without the alias map
(fixed in #324). The alias map existed but was always one step behind: an unknown source created a
folder on its first capture, and a curator could only relayout afterwards.

## Decision

Once `.commonwealth/projects.json` has at least one project, it is the only thing that names a
folder. In `curate`, which every capture path goes through:

1. A declared name (`$COMMONWEALTH_PROJECT` from a host, a manifest `project`, an extractor's
   `project`) resolves against a project's id, `customer` and new `names` list, on letters and
   digits only, case-insensitive.
2. Otherwise the `source` resolves against `sources`, case-insensitive, with `owner/*` matching a
   whole org. An exact entry beats a wildcard.
3. No match: the note is staged without a project. It never auto-promotes, `promote --all` and
   `promote --pr --all` skip it, and `promote <id> --project <id>` files it (the id must exist in
   the registry). `pending` labels it with its source.
4. Allowlist: a git-identity source whose owner appears in no project's sources is refused with
   the `outside-registry` receipt. Folder-name and missing sources are not refused; they go to 3.

An empty or missing registry keeps the previous behavior, so single-project brains are unaffected.

## Consequences

- One project per client is expressible in one entry (`"sources": ["o2o-bicycle-leasing/*"]`).
- Notes from a person's freelance or personal repos never reach a team brain whose registry doesn't
  list their org, even if a routing rule sends them there.
- Unassigned notes sit in the per-user `staging/` queue, which is local and gitignored, so nothing
  without a project is published.
- `promote --pr` now files under `project ?? source`, like local promote (it used `source` only).

## Alternatives

- An `_unsorted/` folder in canon: searchable at once, but it becomes a shared junk drawer.
- Keep folder-name fallback as identity: it is what produced `vault/` and `infra/`.
