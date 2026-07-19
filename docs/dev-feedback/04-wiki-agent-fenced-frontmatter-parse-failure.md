# QA Feedback: wiki-agent writes the wrong `id`/`tags`/`source` and dumps raw LLM output as body text

**Reported by:** `tests/pipeline/agent-wiki-compilation.spec.ts:98` (`sample-lore.md compiles into a draft entity referencing it as source`)
**Symptom:** The test expects the compiled draft's frontmatter `id` to equal the note's own filename stem. Actual note produced: `.knowledge-base/01-Processing/location-annun-harbor.md` with frontmatter `id: lore-doc-1784480391556-f1ae6e91` — the filename and the `id` field disagree, `tags: []`, and the note body contains a raw ` ```yaml ` fenced block holding a *second*, complete, well-formed frontmatter+content document that was never parsed out.

This document only analyzes — no code was changed while producing it.

---

## Root Cause

`_enforce_and_write()` (`agents/wiki/tools/compile_wiki.py:156-214`) parses the LLM's raw response with `_FENCE_RE` (`compile_wiki.py:61`):

```python
_FENCE_RE = re.compile(r"^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*\r?\n?", re.DOTALL)
```

This only matches a **bare** Obsidian-style frontmatter block — the string must start (`^`, anchored via `.match()`) directly with `---`. It does not match a markdown code fence. The captured note's raw LLM output instead started with:

<pre>```yaml
---
id: location-annun-harbor
type: location
...
---
## Description
...
```</pre>

`_FENCE_RE.match()` returns `None` against this (the string starts with `` ` `` `` ` `` `` ` ``, not `-`), so the code silently falls into the no-match branch:

```python
m = _FENCE_RE.match(llm_output)
if m:
    ...
else:
    fm   = {}
    body = llm_output          # the ENTIRE raw response, fences and all, becomes the body
```

From there, every default-fill in `_enforce_and_write` runs against an **empty** `fm`, producing exactly what the test caught:

- `fm.get("type", "")` is `""`, not in `_ALLOWED_TYPES` → falls back to `"lore"` (`compile_wiki.py:197-198`)
- `fm.get("id")` is falsy → synthesized as `f"{fm['type']}-{to_slug(Path(source_name).stem)}"` = `"lore-doc-1784480391556-f1ae6e91"` (`compile_wiki.py:201-202`) — this is the wrapper id that ended up in frontmatter, completely disconnected from the LLM's own `id: location-annun-harbor` (which is now just inert text inside the body)
- `fm["tags"]` defaults to `[]` (`compile_wiki.py:211-212`) — the LLM's real tags (`coastal`, `folklore`, `mystery`, `nautical`, `supernatural`) are lost inside the unparsed body
- `fm["source"] = [source_name]` (`compile_wiki.py:194`) is the one field that's still correct, since it's always overwritten regardless of what the LLM produced

The output file's **name** (`location-annun-harbor.md`) is chosen separately by `_unique_output(slug)` (`compile_wiki.py:139-153`) — evidently from a slug resolved elsewhere in the pipeline before this frontmatter fallback kicks in — which is why the filename reflects the LLM's *real* intended id while the frontmatter inside the file reflects the fallback path. The two disagree because one code path succeeded at reading the LLM's intent and the other silently didn't.

Net effect: this draft is not actually broken by the vault's structural rules (every enforced field is technically present and valid-shaped — that's why `assertDraftInvariants`-style checks wouldn't necessarily catch it either), but it is semantically wrong: the real generated lore content is buried as unparsed body text, tagged/categorized as a generic fallback stub instead of what the model actually produced.

---

## Steps to Reproduce

1. Drop `tests/fixtures/test-docs/sample-lore.md` into `.knowledge-base/00-Inbox/docs/` and wait for `wiki-agent` (poll `01-Processing/*.md` for a `source:` referencing the dropped file).
2. This reproduces only when the configured LLM (LocalRouter, per `agents/wiki/CLAUDE.md`) responds with its frontmatter wrapped in a ` ```yaml ` fence instead of bare `---`-delimited frontmatter at the very start of the message — observed live in this run, not synthetic.
3. Inspect the resulting note: `id` in frontmatter will not match the file's own name, `tags: []`, and the file body will contain a full second `---...---` block plus prose inside a fenced code block.

---

## Proposed Solution

`agents/wiki/tools/compile_wiki.py` — before falling back to `fm = {}`, also try stripping a leading code fence and re-checking for frontmatter inside it:

```python
_CODE_FENCE_RE = re.compile(r"^```(?:ya?ml)?[ \t]*\r?\n(.*?)\r?\n```[ \t]*\r?\n?", re.DOTALL)

m = _FENCE_RE.match(llm_output)
if not m:
    fenced = _CODE_FENCE_RE.match(llm_output)
    if fenced:
        m = _FENCE_RE.match(fenced.group(1) + "\n")  # re-run frontmatter parse on the unwrapped content
        if m:
            llm_output = fenced.group(1) + "\n"  # so `body = llm_output[m.end():]` below still slices correctly
```

This keeps the existing enforced-field logic untouched and only widens what counts as "the LLM emitted frontmatter" to include the fenced form the model is evidently prone to producing. Recommend also logging a warning (distinct from the current silent fallback) whenever `_FENCE_RE` fails to match at all, even after the fence-stripping attempt — today a total parse failure and a "the LLM genuinely wrote no frontmatter" case are indistinguishable in the logs, both silently producing a stub-id draft.
