---
"@cmnwlth/core": minor
"@cmnwlth/sync": patch
---

A brain can hold a hand-written `README.md`. `README.md` (at any depth) is now USER-OWNED, never derived: `isDerivedMarkdownFile` excludes it, so `verify-restore` no longer reports a hand-written root/`docs/`/`.github/` README as permanent derived drift — which failed the generated CI gate on every push — and `regenerateDerived` no longer prunes it. `initBrain` scaffolds a starter README (templated with the brain name: what a Commonwealth brain is, the note kinds and layout, which files are generated, the `commonwealth`/`/commonwealth:*` command surface, and the describe-don't-quote rule for secrets), written absent-only so an existing or hand-edited README is never overwritten. The pre-commit secret scrub keeps covering READMEs explicitly.
