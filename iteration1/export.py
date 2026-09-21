from __future__ import annotations

import argparse
import difflib
import json
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_RESEARCH_DIR = BASE_DIR / "research" / "iteration1"
DEFAULT_DATA_DIR = BASE_DIR / "data"

INTERACTION_EVENTS = (
    "consult_displayed", "consult_discarded", "consult_error", "consult_failed",
    "field_relayout", "peek", "open_item", "source_expanded", "pin", "unpin",
    "line_note", "line_note_reanchored", "cycle_reflection", "annotated_view",
    "field_view", "draft_saved", "poem_version",
)
OPENED_ORIGINS = ("field", "keyboard")
TYPE_WORDS = {"poetry": "poetry", "prose_excerpt": "prose", "note": "note",
              "fragment": "fragment"}


def load_rows(log_path: Path) -> tuple[list[dict], int]:
    rows, bad = [], 0
    if not log_path.exists():
        return rows, bad
    with log_path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                bad += 1
    return rows, bad


def sessions_in(rows: list[dict]) -> list[dict]:
    out: dict[str, dict] = {}
    for r in rows:
        sid = r.get("session_id")
        if not sid:
            continue
        e = out.setdefault(sid, {"session_id": sid, "schemas": set(),
                                 "rows": 0, "first_ts": r.get("ts")})
        e["schemas"].add(r.get("schema_version"))
        e["rows"] += 1
    return [{**e, "schemas": sorted(x for x in e["schemas"] if x is not None)}
            for e in sorted(out.values(), key=lambda x: x["first_ts"] or "")]


def session_rows(rows: list[dict], session_id: str) -> list[dict]:
    mine = [r for r in rows if r.get("session_id") == session_id]
    if not mine:
        raise ValueError(f"no rows for session {session_id}")
    v3 = [r for r in mine if r.get("schema_version") == 3]
    if not v3:
        schemas = sorted({r.get("schema_version") for r in mine})
        raise ValueError(
            f"session {session_id} uses unsupported schemas: {schemas}")

    run_order: dict[str, int] = {}
    for r in v3:
        run_order.setdefault(r.get("run_id"), len(run_order))
    v3.sort(key=lambda r: (run_order[r.get("run_id")], r.get("seq", 0)))
    seen, out = set(), []
    for r in v3:
        key = (r.get("page_id"), r.get("client_seq"))
        if r.get("page_id") is not None and r.get("client_seq") is not None:
            if key in seen:
                continue
            seen.add(key)
        out.append(r)
    return out


def resolve_archive(data_dir: Path, archive_hash: str) -> dict:
    candidates = [data_dir / "versions" / f"archive_{archive_hash[:8]}.json",
                  data_dir / "archive.json"]
    for path in candidates:
        if path.exists():
            try:
                a = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                continue
            if a.get("archive_hash") == archive_hash:
                return {it["item_id"]: it for it in a.get("items", [])}
    return {}


def _replay_notes(rows: list[dict]) -> dict[str, dict]:
    notes: dict[str, dict] = {}
    start = next((r for r in rows if r.get("event") == "session_start"), None)
    for n in (start or {}).get("notes_inherited", []) or []:
        if isinstance(n, dict) and n.get("id"):
            notes[n["id"]] = {**n, "inherited": True}
    for r in rows:
        if r.get("event") == "line_note":
            nid = r.get("note_id")
            if r.get("action") == "delete":
                notes.pop(nid, None)
                continue
            prev = notes.get(nid, {})
            notes[nid] = {
                **prev,
                "id": nid, "line_index": r.get("line_index"),
                "line_text": r.get("line_text"), "text": r.get("text"),
                "anchor_text": r.get("anchor_text", prev.get("anchor_text")),
                "status": r.get("status"),
                "created_ts": r.get("created_ts") or prev.get("created_ts") or r.get("ts"),
                "created_poem_version": (r.get("created_poem_version")
                                         or prev.get("created_poem_version")
                                         or r.get("poem_version")),
                "created_consult_id": (r.get("created_consult_id")
                                       or prev.get("created_consult_id")
                                       or r.get("consult_id")),
                "updated_ts": r.get("updated_ts") or r.get("ts"),
                "last_action": r.get("action"),
                "last_poem_version": r.get("poem_version"),
            }
        elif r.get("event") == "line_note_reanchored":
            nid = r.get("note_id")
            n = notes.get(nid)
            if n is None:
                n = notes[nid] = {"id": nid, "text": None, "unresolved": True}
            n["line_index"] = r.get("to_index")
            n["status"] = r.get("to_status")
            if r.get("line_text") is not None:
                n["line_text"] = r.get("line_text")
    return notes


def _replay_pins(rows: list[dict], session_start_pins: list) -> list[dict]:
    pins: dict[str, dict] = {i: {"item_id": i, "inherited": True}
                             for i in session_start_pins}
    for r in rows:
        if r.get("event") == "startup_warning":
            for i in r.get("orphan_pins", []) or []:
                pins.pop(i, None)
        elif r.get("event") == "pin":
            pins[r["item_id"]] = {k: r.get(k) for k in (
                "item_id", "consult_id", "rank", "rank_raw", "score",
                "query_line", "line_index", "origin", "pinned_ts", "ts")}
        elif r.get("event") == "unpin":
            pins.pop(r.get("item_id"), None)
    return list(pins.values())


#Rebuild session state from the event log.
def reconstruct_episodes(all_rows: list[dict], items_by_id: dict) -> dict:
    end_pos = next((i for i, r in enumerate(all_rows)
                    if r.get("event") == "session_end"), None)
    rows = all_rows if end_pos is None else all_rows[:end_pos + 1]
    after_end = [] if end_pos is None else all_rows[end_pos + 1:]
    versions = {r["version"]: r for r in rows if r.get("event") == "poem_version"}
    discarded = {r.get("consult_id") for r in rows
                 if r.get("event") == "consult_discarded"}
    consults = [r for r in rows if r.get("event") == "consult"]
    errors = [r for r in rows if r.get("event") in ("consult_error", "consult_failed")]
    start = next((r for r in rows if r.get("event") == "session_start"), None)
    end = next((r for r in rows if r.get("event") == "session_end"), None)
    notes_rows = [r for r in rows if r.get("event") == "session_note"]
    by_consult: dict[str, dict[str, set]] = {}
    for r in rows:
        cid = r.get("consult_id")
        if not cid:
            continue
        d = by_consult.setdefault(cid, {"peeked": set(), "opened": set(),
                                        "pinned": set(), "source_opened": set()})
        if r.get("event") == "peek":
            d["peeked"].add(r.get("item_id"))
        elif r.get("event") == "open_item" and r.get("origin") in OPENED_ORIGINS:
            d["opened"].add(r.get("item_id"))
        elif r.get("event") == "source_expanded":
            d["source_opened"].add(r.get("item_id"))
        elif r.get("event") == "pin":
            d["pinned"].add(r.get("item_id"))

    reflections: dict[str, dict] = {}
    for r in rows:
        if r.get("event") != "cycle_reflection":
            continue
        if r.get("action") == "delete":
            reflections.pop(r.get("consult_id"), None)
        else:
            reflections[r.get("consult_id")] = {"text": r.get("text"), "ts": r.get("ts"),
                                                "poem_version": r.get("poem_version")}
    displayed = {r.get("consult_id"): r for r in rows
                 if r.get("event") == "consult_displayed"}

    def pos(r):
        return rows.index(r)

    episodes = []
    for n, c in enumerate(consults):
        here = pos(c)
        nxt = pos(consults[n + 1]) if n + 1 < len(consults) else \
            (pos(end) if end else len(rows))
        between = rows[here + 1:nxt]
        after_versions = [r for r in between if r.get("event") == "poem_version"]
        before = versions.get(c.get("poem_version"))
        after = after_versions[-1] if after_versions else before
        seen = by_consult.get(c["consult_id"], {"peeked": set(), "opened": set(),
                                                "pinned": set(), "source_opened": set()})
        disp = displayed.get(c["consult_id"], {})
        was_shown = c["consult_id"] not in discarded
        label_state = {nd.get("item_id"): nd.get("label_state")
                       for nd in disp.get("nodes", [])}
        pinned_before = set(c.get("pins_at_consult", []) or [])
        results = []
        for res in c.get("results", []):
            iid = res.get("item_id")
            item = items_by_id.get(iid, {})
            results.append({
                **res,
                "display_text": item.get("display_text"),
                "source_title": item.get("source_title"),
                "creator": item.get("creator"),
                "label_state": label_state.get(iid),
                "peeked": iid in seen["peeked"],
                "opened": iid in seen["opened"],
                "source_opened": iid in seen["source_opened"],
                "pinned": iid in seen["pinned"],
                "pinned_before": iid in pinned_before,
            })

        ignored = [] if not was_shown else [
            r["item_id"] for r in results
            if not (r["peeked"] or r["opened"] or r["pinned"] or r["pinned_before"])]
        diff = ""
        if before and after and before is not after:
            diff = "".join(difflib.unified_diff(
                before.get("text", "").splitlines(keepends=True),
                after.get("text", "").splitlines(keepends=True),
                fromfile=f"v{before.get('version')}",
                tofile=f"v{after.get('version')}"))
        episodes.append({
            "n": n + 1,
            "consult_id": c["consult_id"],
            "displayed_to_poet": was_shown,
            "ts": c.get("ts"),
            "trigger": c.get("trigger"),
            "line": c.get("line"),
            "line_index": c.get("line_index"),
            "caret_index": c.get("caret_index"),
            "line_matches_draft": c.get("line_matches_draft"),
            "poem_before": _version_ref(before),
            "poem_after": _version_ref(after),
            "results": results,
            "suppressed": c.get("suppressed", []),
            "retrieval_policy": c.get("retrieval_policy"),
            "pins_at_consult": c.get("pins_at_consult", []),
            "displayed": {k: disp.get(k) for k in (
                "field_layout", "radius_policy", "pins_at_display",
                "panel_item", "label_measured", "field_css_px")} if disp else None,
            "ignored": ignored,
            "interactions": [_compact_row(r) for r in between
                             if r.get("event") in INTERACTION_EVENTS],
            "notes": [_compact_row(r) for r in between
                      if r.get("event") == "line_note"],
            "reflection": reflections.get(c["consult_id"]),
            "diff_to_after": diff,
        })

    last_version = max(versions) if versions else None
    final = versions.get(last_version) if last_version else None
    return {
        "session_id": rows[0].get("session_id"),
        "schema_version": 3,
        "archive_hash": rows[0].get("archive_hash"),
        "archive_version": rows[0].get("archive_version"),
        "model_name": rows[0].get("model_name"),
        "model_revision": rows[0].get("model_revision"),
        "runs": list(dict.fromkeys(r.get("run_id") for r in rows)),
        "started_ts": (start or rows[0]).get("ts"),
        "ended_ts": end.get("ts") if end else None,
        "ended": end is not None,
        "inherited": {"pins": (start or {}).get("pins", []),
                      "notes": (start or {}).get("notes", 0),
                      "draft_chars": (start or {}).get("draft_chars")},
        "counts": {
            "rows": len(rows),
            "consults": sum(1 for c in consults if c["consult_id"] not in discarded),
            "consults_discarded": len(discarded),
            "consults_failed": len(errors),
            "versions": len(versions),
            "peeks": sum(1 for r in rows if r.get("event") == "peek"),
            "opens": sum(1 for r in rows if r.get("event") == "open_item"),
            "pins": sum(1 for r in rows if r.get("event") == "pin"),
            "unpins": sum(1 for r in rows if r.get("event") == "unpin"),
            "line_notes": sum(1 for r in rows if r.get("event") == "line_note"),
            "reflections": len(reflections),
            "source_opens": sum(1 for r in rows if r.get("event") == "source_expanded"),
        },
        "session_note": "\n\n".join(r.get("text", "") for r in notes_rows) or None,
        "final_version": _version_ref(final),
        "versions": [_version_ref(versions[v]) for v in sorted(versions)],
        "notes": list(_replay_notes(rows).values()),
        "reflections": reflections,
        "pins": _replay_pins(rows, (start or {}).get("pins", [])),
        "failed_consults": [{"ts": r.get("ts"), "event": r.get("event"),
                             "line": r.get("line"), "line_index": r.get("line_index"),
                             "error": r.get("error")} for r in errors],
        "episodes": episodes,
        "after_end": {"rows": len(after_end),
                      "events": sorted({r.get("event") for r in after_end})},
    }


def _version_ref(v: dict | None) -> dict | None:
    if not v:
        return None
    return {"version": v.get("version"), "poem_hash": v.get("poem_hash"),
            "reason": v.get("reason"), "ts": v.get("ts"),
            "title": v.get("title", ""), "text": v.get("text", "")}


def _compact_row(r: dict) -> dict:
    skip = {"model_name", "model_revision", "archive_hash", "archive_version",
            "schema_version", "session_id", "run_id", "page_id", "client_seq"}
    if r.get("event") == "poem_version":
        skip |= {"title", "text"}
    return {k: v for k, v in r.items() if k not in skip}


def render_annotated_md(title: str, text: str, notes: list[dict]) -> str:
    anchored = {n["line_index"]: n for n in notes
                if n.get("status") == "anchored" and n.get("text")}
    detached = [n for n in notes if n.get("status") != "anchored"]
    out = [f"# {title}" if title.strip() else "# (untitled)", ""]
    for i, line in enumerate(text.split("\n")):
        out.append(line)
        if i in anchored and anchored[i].get("text", "").strip():
            for gl in anchored[i]["text"].split("\n"):
                out.append(f"    > {gl}")
    if detached:
        out += ["", "## detached notes", ""]
        for n in detached:
            out.append(f"- (was on: “{n.get('line_text', '')}”) {n.get('text') or ''}")
    return "\n".join(out).rstrip() + "\n"


def _mark_line(text: str, index) -> str:
    lines = text.split("\n")
    return "\n".join(("→ " if i == index else "  ") + l
                     for i, l in enumerate(lines))


def render_episodes_md(data: dict) -> str:
    o = [f"# Session {data['session_id']}", ""]
    o.append(f"- started: {data['started_ts']}")
    o.append(f"- ended: {data['ended_ts'] or 'not ended'}")
    o.append(f"- runs: {', '.join(r for r in data['runs'] if r)}")
    o.append(f"- archive: {data['archive_version']} ({(data['archive_hash'] or '')[:8]}) · "
             f"model {data['model_name']} ({(data['model_revision'] or '')[:8]})")
    c = data["counts"]
    o.append(f"- consults {c['consults']} (discarded {c['consults_discarded']}, failed "
             f"{c['consults_failed']}) · versions {c['versions']} · peeks {c['peeks']} · "
             f"opens {c['opens']} (sources {c['source_opens']}) · pins {c['pins']} · "
             f"unpins {c['unpins']} · line notes {c['line_notes']} · "
             f"cycle reflections {c['reflections']}")
    inh = data["inherited"]
    o.append(f"- inherited at start: {len(inh['pins'])} pins, {inh['notes']} notes, "
             f"{inh['draft_chars']} chars of draft")
    if data["after_end"]["rows"]:
        o.append(f"- after End session: {data['after_end']['rows']} more rows "
                 f"({', '.join(e for e in data['after_end']['events'] if e)}) — "
                 "recorded, not part of this session's episodes")
    if data["failed_consults"]:
        o.append("- consults that returned nothing: " + "; ".join(
            f"line {f['line_index']} “{f['line']}” ({f['error']})" for f in data["failed_consults"]))
    o.append("")
    for ep in data["episodes"]:
        o.append(f"## Episode {ep['n']} — {ep['consult_id']} ({ep['ts']})")
        o.append("")
        o.append(f"Consulted line {ep['line_index']} via {ep['trigger']}"
                 + ("" if ep["line_matches_draft"] else " (line had drifted)")
                 + f": “{ep['line']}”")
        o.append("")
        if not ep["displayed_to_poet"]:
            o.append("Computed but never displayed: a newer consult superseded it before "
                     "the answer arrived. Its ranking is in events.jsonl.")
            o.append("")
            continue
        pb = ep["poem_before"]
        if pb:
            o.append(f"### Poem before (v{pb['version']})")
            o.append("")
            o.append("```")
            o.append(_mark_line(pb["text"], ep["line_index"]))
            o.append("```")
            o.append("")
        o.append("### Archive field (top-10)")
        o.append("")
        o.append("| # | raw | type | unit | readable | seen | opened | pinned |")
        o.append("|---|-----|------|------|----------|------|--------|--------|")
        for r in ep["results"]:
            unit = (r.get("display_text") or r["item_id"]).split("\n")[0]
            pinned = "✓" if r["pinned"] else ("◉ already" if r.get("pinned_before") else "")
            opened = ("✓" if r["opened"] else "") + (" ⤓ source" if r.get("source_opened") else "")
            o.append(f"| {r['rank']} | {r['rank_raw']} | {TYPE_WORDS.get(r.get('item_type'), r.get('item_type'))} "
                     f"| {unit} | {r.get('label_state') or '?'} | {'✓' if r['peeked'] else ''} "
                     f"| {opened.strip()} | {pinned} |")
        if ep["suppressed"]:
            o.append("")
            o.append("Suppressed by the per-source cap: " + ", ".join(
                f"{s['item_id']} (raw {s['rank_raw']})" for s in ep["suppressed"]))
        o.append("")
        o.append("Ignored (shown, never seen/opened/pinned, not already in the tray): "
                 + (", ".join(ep["ignored"]) if ep["ignored"] else "none"))
        o.append("")
        o.append("Raw cosines: " + ", ".join(
            f"{r['item_id']} {r['score']:.3f}" for r in ep["results"]))
        o.append("")
        if ep["notes"]:
            o.append("### Line notes written during this episode")
            o.append("")
            for n in ep["notes"]:
                o.append(f"- [{n.get('action')}] line {n.get('line_index')} “{n.get('line_text')}”: "
                         f"{n.get('text')}")
            o.append("")
        if ep.get("reflection"):
            o.append("### Reflection on this cycle")
            o.append("")
            o.append(ep["reflection"]["text"])
            o.append("")
        pa = ep["poem_after"]
        if pa and pb and pa["version"] != pb["version"]:
            o.append(f"### Poem after (v{pa['version']}) — diff")
            o.append("")
            o.append("```diff")
            o.append(ep["diff_to_after"].rstrip())
            o.append("```")
        else:
            o.append("The poem did not change before the next consult.")
        o.append("")
    if data["session_note"]:
        o += ["## Session reflection", "", data["session_note"], ""]
    fv = data["final_version"]
    if fv:
        o += [f"## Final poem (v{fv['version']})", "", "```", fv["text"], "```", ""]
    return "\n".join(o)


README = """Session export

session.json           Session summary and reconstructed episodes.
events.jsonl           Recorded events.
versions/              Saved poem versions.
poem_final.txt         Final poem.
annotated_poem.md      Final poem with line notes.
notes.json             Line notes.
pins.json              Pinned items.
archive_items_used.json Archive items used during the session.
episodes.md            Consultations and subsequent changes.
"""


def write_bundle(research_dir: Path, data_dir: Path, session_id: str) -> list[Path]:
    research_dir, data_dir = Path(research_dir), Path(data_dir)
    rows, _bad = load_rows(research_dir / "log.jsonl")
    mine = session_rows(rows, session_id)
    items = resolve_archive(data_dir, mine[0].get("archive_hash", ""))
    data = reconstruct_episodes(mine, items)
    out = research_dir / "exports" / session_id
    (out / "versions").mkdir(parents=True, exist_ok=True)
    files = []

    def put(name: str, content: str) -> None:
        p = out / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        files.append(p)

    put("session.json", json.dumps(data, ensure_ascii=False, indent=1))
    put("events.jsonl", "".join(json.dumps(r, ensure_ascii=False) + "\n"
                                for r in mine))
    for v in data["versions"]:
        put(f"versions/{v['version']:03d}.txt", f"{v['title']}\n\n{v['text']}")
    fv = data["final_version"] or {"title": "", "text": ""}
    put("poem_final.txt", f"{fv['title']}\n\n{fv['text']}")
    put("annotated_poem.md", render_annotated_md(fv.get("title", ""), fv.get("text", ""),
                                                 data["notes"]))
    put("notes.json", json.dumps(data["notes"], ensure_ascii=False, indent=1))
    put("pins.json", json.dumps(data["pins"], ensure_ascii=False, indent=1))
    used = sorted({r["item_id"] for ep in data["episodes"]
                   for r in ep["results"] + ep["suppressed"]})
    put("archive_items_used.json", json.dumps(
        {i: items.get(i, {"item_id": i, "unresolved": True}) for i in used},
        ensure_ascii=False, indent=1))
    put("episodes.md", render_episodes_md(data))
    put("README.txt", README)
    return files


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Export locally saved sessions.",
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--research-dir", default=str(DEFAULT_RESEARCH_DIR))
    ap.add_argument("--data-dir", default=str(DEFAULT_DATA_DIR))
    ap.add_argument("--session", help="session_id to export")
    ap.add_argument("--all", action="store_true", help="export every schema-3 session")
    ap.add_argument("--list", action="store_true", help="list sessions in the log")
    args = ap.parse_args(argv)
    research_dir = Path(args.research_dir)
    rows, bad = load_rows(research_dir / "log.jsonl")
    if bad:
        print(f"note: {bad} unreadable line(s) in log.jsonl were skipped")
    found = sessions_in(rows)
    if args.list or not (args.session or args.all):
        for s in found:
            print(f"{s['session_id']}  rows {s['rows']:4d}  schema {s['schemas']}  "
                  f"first {s['first_ts']}")
        if not found:
            print(f"no sessions in {research_dir / 'log.jsonl'}")
        return 0
    targets = [args.session] if args.session else \
        [s["session_id"] for s in found if 3 in s["schemas"]]
    rc = 0
    for sid in targets:
        try:
            files = write_bundle(research_dir, Path(args.data_dir), sid)
            print(f"{sid}: wrote {len(files)} files to {files[0].parent}")
        except ValueError as exc:
            print(f"{sid}: {exc}")
            rc = 1
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
