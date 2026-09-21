from __future__ import annotations

import json
from pathlib import Path

import config

NO_INTERACTION = "no recorded interaction"


def _rows(path: Path) -> list[dict]:
    out = []
    try:
        with path.open(encoding="utf-8") as f:
            for line in f:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except FileNotFoundError:
        pass
    return out


def _poem_title(rows: list[dict]) -> str:

    title, first = "", ""
    for r in rows:
        if r.get("event") == "poem_version":
            if (r.get("title") or "").strip():
                title = r["title"].strip()
            text = r.get("text") or ""
            for ln in text.split("\n"):
                if ln.strip():
                    first = ln.strip()
                    break
    return title or first


def encounters_in(rows: list[dict], item_id: str, phase: str,
                  only_sessions: set[str] | None = None,
                  exclude_session: str | None = None,
                  ended_only: bool = True) -> list[dict]:

    by: dict[str, list[dict]] = {}
    for r in rows:
        sid = r.get("session_id")
        if not sid:
            continue
        if only_sessions is not None and sid not in only_sessions:
            continue
        if sid == exclude_session:
            continue
        by.setdefault(sid, []).append(r)
    out = []
    for sid, rs in by.items():
        #Exclude unfinished sessions from the default lookup.
        if ended_only and not any(r.get("event") == "session_end" for r in rs):
            continue
        title = _poem_title(rs)
        consults = [r for r in rs if r.get("event") == "consult"]
        for c in consults:
            if not any(x.get("item_id") == item_id for x in c.get("results", [])):
                continue
            cid = c.get("consult_id")
            opened = any(r.get("event") == "open_item" and r.get("item_id") == item_id
                         and r.get("consult_id") == cid for r in rs)
            pinned = any(r.get("event") == "pin" and r.get("item_id") == item_id
                         and r.get("consult_id") == cid for r in rs)
            notes = [r.get("text") for r in rs
                     if r.get("event") == "line_note" and r.get("action") in ("create", "edit")
                     and r.get("consult_id") == cid and r.get("panel_item") == item_id
                     and (r.get("text") or "").strip()]
            reflections = [r.get("text") for r in rs
                           if r.get("event") == "cycle_reflection" and r.get("action") in ("create", "edit")
                           and r.get("consult_id") == cid and opened and (r.get("text") or "").strip()]

            annotation = []
            if notes:
                annotation.append(notes[-1])
            if reflections:
                annotation.append(reflections[-1])
            facts = []
            if opened:
                facts.append("opened")
            if pinned:
                facts.append("pinned")
            if annotation:
                facts.append("annotated by the poet")
            out.append({
                "session_id": sid,
                "phase": phase,
                "consult_id": cid,
                "poem_title": title,
                "queried_line": c.get("line"),
                "opened": opened,
                "pinned": pinned,
                "explicit_annotation": annotation,
                "interaction": ", ".join(facts) if facts else NO_INTERACTION,
            })
    return out


def encounters(item_id: str, current_session_id: str | None,
               phase_log: Path | None, phase: str) -> list[dict]:

    out = []
    i1 = Path(config.I1_RECORD_DIR) / "log.jsonl"
    out += encounters_in(_rows(i1), item_id, "iteration1",
                         only_sessions=set(config.I1_FORMAL_SESSIONS))
    if phase_log is not None:
        out += encounters_in(_rows(phase_log), item_id, phase,
                             exclude_session=current_session_id, ended_only=True)
    return out


def summary(encs: list[dict]) -> dict:
    sessions = sorted({e["session_id"] for e in encs})
    return {"sessions": len(sessions), "encounters": len(encs),
            "opened": sum(1 for e in encs if e["opened"]),
            "pinned": sum(1 for e in encs if e["pinned"]),
            "annotated": sum(1 for e in encs if e["explicit_annotation"])}
