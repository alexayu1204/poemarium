from __future__ import annotations

import datetime as _dt
import fcntl
import hashlib
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, field_validator

import config
from ingest import compute_archive_hash, empty_archive
from model import embed_texts, get_model, model_revision

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

ENVELOPE_KEYS = frozenset({
    "ts", "seq", "run_id", "session_id", "schema_version", "model_name",
    "model_revision", "archive_hash", "archive_version", "poem_version",
    "event", "post_end",
})
NOTE_ACTIONS = ("create", "edit", "attach", "delete")
NOTE_STATUSES = ("anchored", "orphaned")
PIN_ORIGINS = ("field", "panel", "tray")


def _utcnow() -> _dt.datetime:
    return _dt.datetime.now(_dt.timezone.utc)


def _compact(dt: _dt.datetime) -> str:
    return dt.strftime("%Y%m%d_%H%M%S")


def _clean(obj):
    if isinstance(obj, str):
        return obj.encode("utf-16", "surrogatepass").decode("utf-16", "replace")
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_clean(v) for v in obj]
    return obj


def poem_hash(title: str, text: str) -> str:
    return hashlib.sha256(
        f"{title}\n\n{text}".encode("utf-8", "replace")).hexdigest()


def _read_json(path: Path, default, expect_type=None):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default, False
    except (json.JSONDecodeError, UnicodeDecodeError):
        return default, True
    if expect_type is not None and not isinstance(value, expect_type):
        return default, True
    return value, False


#Replace the saved file atomically.
def _write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(_clean(obj), ensure_ascii=False, indent=1),
                   encoding="utf-8")
    os.replace(tmp, path)


class CleanModel(BaseModel):
    @field_validator("*", mode="before")
    @classmethod
    def _clean_strings(cls, v):
        return _clean(v)


class ConsultRequest(CleanModel):
    line: str
    line_index: int = 0
    caret_index: int | None = None
    title: str = ""
    draft_text: str = ""
    trigger: str = "keyboard"
    client_ts: str | None = None


class NoteModel(CleanModel):
    id: str
    line_index: int
    line_text: str = ""
    anchor_text: str = ""
    text: str = ""
    status: str = "anchored"
    created_ts: str | None = None
    updated_ts: str | None = None
    created_poem_version: int | None = None
    created_consult_id: str | None = None


class DraftRequest(CleanModel):
    title: str = ""
    text: str = ""
    annotations: list[NoteModel] = []
    client_ts: str | None = None


class LineNoteRequest(CleanModel):
    action: str
    note: NoteModel
    title: str = ""
    draft_text: str = ""
    consult_id: str | None = None
    panel_item: str | None = None
    client_ts: str | None = None


class PinRequest(CleanModel):
    item_id: str
    consult_id: str | None = None
    rank: int | None = None
    rank_raw: int | None = None
    score: float | None = None
    query_line: str = ""
    line_index: int | None = None
    origin: str = "field"
    client_ts: str | None = None


class UnpinRequest(CleanModel):
    item_id: str
    origin: str = "tray"
    client_ts: str | None = None


class EventRequest(CleanModel):
    type: str
    payload: dict = {}
    client_ts: str | None = None
    client_seq: int | None = None
    page_id: str | None = None


class SessionNoteRequest(CleanModel):
    text: str


class ReflectionRequest(CleanModel):
    consult_id: str
    text: str = ""
    title: str = ""
    draft_text: str = ""
    client_ts: str | None = None


class NewSessionRequest(CleanModel):
    clear_poem: bool = False
    client_ts: str | None = None


def create_app(data_dir: str | Path | None = None,
               research_dir: str | Path | None = None,
               embedder=None, exclusive: bool = True) -> FastAPI:
    data_dir = Path(data_dir or os.environ.get("POETRY_DATA_DIR")
                    or (BASE_DIR / "data"))
    research_dir = Path(research_dir or os.environ.get("POETRY_RESEARCH_DIR")
                        or (BASE_DIR / "research" / "iteration1"))
    log_path = research_dir / "log.jsonl"
    pins_path = research_dir / "pins.json"
    session_path = research_dir / "session.json"
    draft_path = research_dir / "draft.json"

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        st = app.state
        research_dir.mkdir(parents=True, exist_ok=True)
        st.lock_fd = None
        if exclusive:
            st.lock_fd = os.open(research_dir / ".lock", os.O_RDWR | os.O_CREAT)
            try:
                fcntl.flock(st.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                os.close(st.lock_fd)
                raise RuntimeError(
                    f"another poemarium server is already using {research_dir}")

        #Start with an empty archive when no local data exists.
        archive_file = data_dir / "archive.json"
        st.archive = (
            json.loads(archive_file.read_text(encoding="utf-8"))
            if archive_file.exists() else empty_archive()
        )
        st.items_by_id = {it["item_id"]: it for it in st.archive["items"]}
        st.sources = st.archive.get("sources") or {}
        st.archive_version = st.archive.get("archive_version", "unknown")

        st.model_name = config.MODEL_NAMES[config.MODEL_KEY]
        st.model_revision = "MODEL_REVISION_PLACEHOLDER"
        st.vectors = None
        st.vector_ids = []
        st.embeddings_archive_hash = None
        startup_warnings: list[str] = []
        if (config.ARCHIVE_WORKBOOK_SHA256
                and st.archive.get("workbook_sha256") != config.ARCHIVE_WORKBOOK_SHA256):
            startup_warnings.append(
                "archive.json does not match the configured workbook "
                f"{config.ARCHIVE_WORKBOOK_SHA256[:8]} — run ingest.py")
        if compute_archive_hash(st.archive["items"], st.sources) != st.archive["archive_hash"]:
            startup_warnings.append(
                "archive.json contents do not match its archive_hash "
                "(edited by hand?) — run ingest.py")
        npz_path = data_dir / f"embeddings_{config.MODEL_KEY}.npz"
        if npz_path.exists():
            npz = np.load(str(npz_path), allow_pickle=False)
            st.vectors = np.asarray(npz["vectors"], dtype=np.float32)
            st.vector_ids = [str(x) for x in npz["item_ids"]]
            st.model_name = str(npz["model_name"][()])
            st.model_revision = str(npz["model_revision"][()])
            st.embeddings_archive_hash = (
                str(npz["archive_hash"][()])
                if "archive_hash" in npz.files else None)

            if st.embeddings_archive_hash != st.archive["archive_hash"]:
                startup_warnings.append(
                    "embeddings were built from archive "
                    f"{(st.embeddings_archive_hash or 'unknown')[:8]} but the "
                    f"current archive is {st.archive['archive_hash'][:8]} — "
                    "run ingest.py --embed")
            missing = [i for i in st.vector_ids if i not in st.items_by_id]
            if missing:
                startup_warnings.append(
                    f"{len(missing)} embedded item_ids are missing from "
                    f"archive.json (e.g. {missing[:3]})")
        if embedder is not None:
            st.embedder = embedder
        elif st.vectors is not None and not startup_warnings:
            try:
                model = get_model(config.MODEL_KEY)
            except NotImplementedError:
                st.embedder = None
            else:
                live_rev = model_revision(model)
                if live_rev != st.model_revision:
                    startup_warnings.append(
                        "The model revision does not match the stored embeddings."
                    )
                    st.embedder = None
                else:
                    st.embedder = lambda texts: embed_texts(model, texts)
        else:
            st.embedder = None

        st.semantic_available = (st.vectors is not None
                                 and len(st.vector_ids) > 0
                                 and st.embedder is not None
                                 and not startup_warnings)
        if startup_warnings:
            st.semantic_unavailable_reason = "Archive index unavailable: " + "; ".join(startup_warnings)
        elif not st.items_by_id:
            st.semantic_unavailable_reason = "Archive data and an embedding model are not included in this repository."
        elif st.embedder is None:
            st.semantic_unavailable_reason = "No embedding model is configured."
        else:
            st.semantic_unavailable_reason = "No archive embeddings are configured."

        now = _utcnow()

        st.run_id = f"r_{_compact(now)}_{os.urandom(2).hex()}"
        st.seq = 0
        st.seen_client_rows = set()
        st.last_consult = None
        st.session_ended = False

        quarantined: list[dict] = []
        stored = _load_json_quiet(session_path, {}, dict, quarantined)
        draft = _draft_from(_load_json_quiet(draft_path, {}, dict, quarantined))
        pins_on_disk = _load_json_quiet(pins_path, [], list, quarantined)

        orphans = [p for p in pins_on_disk
                   if not isinstance(p, dict) or p.get("item_id") not in st.items_by_id]
        if orphans:
            pins_on_disk = [p for p in pins_on_disk if p not in orphans]
            _write_json(pins_path, pins_on_disk)
        if stored.get("session_id") and stored.get("ended_utc") is None:
            stored.setdefault("runs", []).append(st.run_id)
            stored.setdefault("consult_ids", [])
            stored.setdefault("reflections", {})
            idle = None
            if stored.get("updated_utc"):
                try:
                    idle = round((now - _dt.datetime.fromisoformat(
                        stored["updated_utc"])).total_seconds())
                except ValueError:
                    idle = None
            _begin_session(stored, draft, pins_on_disk, resumed=True,
                           extra={"runs": stored["runs"], "idle_seconds": idle})
        else:
            _begin_session(_new_session_dict(now, stored.get("session_id")),
                           draft, pins_on_disk, resumed=False, extra={})
        resumed = st.session_resumed
        for q in quarantined:
            _log(app, "file_corrupt_quarantined", {**q, "at": "startup"})
        for warning in startup_warnings:
            _log(app, "startup_warning", {"warning": warning})
        if orphans:
            _log(app, "startup_warning", {
                "warning": f"{len(orphans)} pinned item_ids are not in this "
                           "archive and were set aside",
                "orphan_pins": [p.get("item_id") if isinstance(p, dict) else None
                                for p in orphans]})
        if resumed:
            _seed_seen_rows()
        try:
            yield
        finally:
            if st.lock_fd is not None:
                try:
                    fcntl.flock(st.lock_fd, fcntl.LOCK_UN)
                    os.close(st.lock_fd)
                except OSError:
                    pass

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError):
        errors = [{"loc": [str(x) for x in e.get("loc", [])],
                   "type": e.get("type"), "msg": _clean(str(e.get("msg", "")))}
                  for e in exc.errors()]
        return JSONResponse(status_code=422, content={
            "detail": "request could not be read (invalid JSON or unencodable text)",
            "errors": errors})

    app.state.paths = {
        "research_dir": research_dir, "log": log_path, "pins": pins_path,
        "session": session_path, "draft": draft_path, "data_dir": data_dir,
    }

    def _log(app_: FastAPI, event: str, payload: dict) -> None:
        st = app_.state
        row = {
            "ts": _utcnow().isoformat(),
            "seq": st.seq + 1,
            "run_id": st.run_id,
            "session_id": st.session_id,
            "schema_version": config.SCHEMA_VERSION,
            "model_name": st.model_name,
            "model_revision": st.model_revision,
            "archive_hash": st.archive["archive_hash"],
            "archive_version": st.archive_version,
            "poem_version": st.poem_version,
            "event": event,
        }
        if st.session_ended:
            row["post_end"] = True
        for k, v in payload.items():
            if k in row:
                raise ValueError(f"payload key {k!r} collides with envelope")
            row[k] = v
        line = json.dumps(_clean(row), ensure_ascii=False) + "\n"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as f:
            f.write(line)
        st.seq += 1

    def _new_session_dict(now: _dt.datetime, previous_id: str | None) -> dict:
        sid = "s_" + _compact(now)
        if previous_id and previous_id.startswith(sid):
            sid = f"{sid}_{os.urandom(2).hex()}"
        return {
            "session_id": sid,
            "started_utc": now.isoformat(),
            "ended_utc": None,
            "updated_utc": now.isoformat(),
            "consult_seq": 0,
            "poem_seq": 0,
            "last_poem_hash": None,
            "runs": [app.state.run_id],
            "consult_ids": [],
            "reflections": {},
        }

    def _begin_session(session: dict, draft: dict, pins: list,
                       resumed: bool, extra: dict) -> None:
        st = app.state
        st.session = session
        st.session_id = session["session_id"]
        st.session_resumed = resumed
        st.session_ended = False
        st.seen_client_rows = set()
        st.last_consult = None
        st.poem_version = session["poem_seq"] or None
        st.last_poem_hash = session.get("last_poem_hash")
        version, changed = _mint_poem_version(draft["title"], draft["text"])
        if resumed:
            _log(app, "session_resumed", extra)
        else:
            _log(app, "session_start", {
                "draft_chars": len(draft["text"]),
                "draft_lines": len(draft["text"].split("\n"))
                if draft["text"] else 0,
                "pins": [p.get("item_id") for p in pins],
                "notes": len(draft.get("annotations", [])),

                "notes_inherited": draft.get("annotations", []),
                "workbook_sha256": st.archive.get("workbook_sha256"),
                **extra,
            })
        if changed:
            _log_poem_version(draft["title"], draft["text"],
                              "session_resumed" if resumed else "session_start")
        _save_session()

    def _session_view() -> dict:
        s = app.state.session
        return {
            "session_id": s["session_id"],
            "started_utc": s["started_utc"],
            "ended_utc": s["ended_utc"],
            "resumed": app.state.session_resumed,
            "consult_seq": s["consult_seq"],
            "reflections": s.get("reflections", {}),
        }

    def _load_json_quiet(path: Path, default, expect_type=None, sink=None):
        value, corrupt = _read_json(path, default, expect_type)
        if corrupt:
            quarantine = path.with_name(
                f"{path.name}.corrupt-{_utcnow().strftime('%Y%m%dT%H%M%S')}")
            try:
                os.replace(path, quarantine)
                name = quarantine.name
            except OSError:
                name = None
            if sink is not None:
                sink.append({"file": path.name, "quarantined_to": name})
        return value

    def _seed_seen_rows() -> None:
        st = app.state
        try:
            with log_path.open(encoding="utf-8") as f:
                for raw in f:
                    try:
                        r = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    if (r.get("session_id") == st.session_id
                            and r.get("page_id") is not None
                            and r.get("client_seq") is not None):
                        st.seen_client_rows.add((r["page_id"], r["client_seq"]))
        except FileNotFoundError:
            pass

    def _load_json(path: Path, default, expect_type=None):
        value, corrupt = _read_json(path, default, expect_type)
        if corrupt:
            quarantine = path.with_name(
                f"{path.name}.corrupt-{_utcnow().strftime('%Y%m%dT%H%M%S')}")
            try:
                os.replace(path, quarantine)
                quarantined_to = quarantine.name
            except OSError:
                quarantined_to = None
            _log(app, "file_corrupt_quarantined", {
                "file": path.name, "quarantined_to": quarantined_to})
        return value

    def _pins() -> list:
        return _load_json(pins_path, [], list)

    def _draft_from(d: dict) -> dict:
        return {"title": str(d.get("title", "")),
                "text": str(d.get("text", "")),
                "annotations": [n for n in d.get("annotations", [])
                                if isinstance(n, dict) and "id" in n]}

    def _draft() -> dict:
        return _draft_from(_load_json(draft_path, {}, dict))

    def _save_session() -> None:
        st = app.state
        st.session["updated_utc"] = _utcnow().isoformat()
        st.session["last_poem_hash"] = st.last_poem_hash
        _write_json(session_path, st.session)

    def _mint_poem_version(title: str, text: str) -> tuple[int, bool]:
        st = app.state
        h = poem_hash(title, text)
        if h == st.last_poem_hash and st.poem_version:
            return st.poem_version, False
        st.session["poem_seq"] += 1
        st.poem_version = st.session["poem_seq"]
        st.last_poem_hash = h
        return st.poem_version, True

    def _log_poem_version(title: str, text: str, reason: str) -> None:
        st = app.state
        _log(app, "poem_version", {
            "version": st.poem_version, "poem_hash": st.last_poem_hash,
            "reason": reason, "title": title, "text": text,
            "chars": len(text), "lines": len(text.split("\n")) if text else 0,
        })

    def _record_poem(title: str, text: str, reason: str) -> tuple[int, str]:
        version, changed = _mint_poem_version(title, text)
        if changed:
            _log_poem_version(title, text, reason)
            _save_session()
        return version, app.state.last_poem_hash

    @app.get("/")
    async def index():
        index_file = STATIC_DIR / "index.html"
        if not index_file.exists():
            return JSONResponse({"error": "static/index.html not built yet"},
                                status_code=404)
        return FileResponse(index_file)

    if STATIC_DIR.exists():
        app.mount("/static", StaticFiles(directory=str(STATIC_DIR)),
                  name="static")

    @app.get("/state")
    async def state():
        st = app.state
        return {
            "run_id": st.run_id,
            "session": _session_view(),
            "draft": _draft(),
            "pins": _pins(),
            "poem_version": st.poem_version,
            "config": {
                "model_name": st.model_name,
                "model_revision": st.model_revision,
                "archive_hash": st.archive["archive_hash"],
                "archive_version": st.archive_version,
                "workbook_sha256": st.archive.get("workbook_sha256"),
                "k": config.K_SEMANTIC,
                "max_per_source": config.MAX_PER_SOURCE,
                "schema_version": config.SCHEMA_VERSION,
                "semantic_available": st.semantic_available,
                "semantic_unavailable_reason": (
                    None if st.semantic_available else st.semantic_unavailable_reason
                ),
                "embeddings_archive_hash": st.embeddings_archive_hash,
            },
        }

    @app.get("/archive")
    async def archive():
        return app.state.archive

    @app.post("/consult")
    async def consult(req: ConsultRequest):
        st = app.state
        if req.trigger not in config.CONSULT_TRIGGERS:
            raise HTTPException(
                422, "trigger must be one of " + ", ".join(config.CONSULT_TRIGGERS))

        version, phash = _record_poem(req.title, req.draft_text, "consult")
        st.session["consult_seq"] += 1
        consult_id = (f"c_{_compact(_utcnow())}"
                      f"_{st.session['consult_seq']:03d}")
        st.session.setdefault("consult_ids", []).append(consult_id)
        _save_session()

        draft_lines = req.draft_text.split("\n")
        line_matches_draft = (0 <= req.line_index < len(draft_lines)
                              and draft_lines[req.line_index] == req.line)
        common = {
            "consult_id": consult_id,
            "trigger": req.trigger,
            "line": req.line,
            "line_index": req.line_index,
            "caret_index": req.caret_index,
            "line_matches_draft": line_matches_draft,
            "poem_hash": phash,
            "client_ts": req.client_ts,
        }
        try:
            results, suppressed = _semantic_results(st, req)
        except Exception as exc:
            detail = (f"{exc.status_code}: {exc.detail}"
                      if isinstance(exc, HTTPException) else repr(exc))
            _log(app, "consult_error", {**common, "error": detail})
            raise
        payload = {
            **common,
            "results": results,
            "suppressed": suppressed,
            "retrieval_policy": {
                "k": config.K_SEMANTIC,
                "max_per_source": config.MAX_PER_SOURCE,
                "query_form": config.QUERY_FORM,
            },
            "pins_at_consult": [p.get("item_id") for p in _pins()],
        }
        _log(app, "consult", payload)
        st.last_consult = {"consult_id": consult_id, "line": req.line,
                           "line_index": req.line_index}
        return {**payload, "poem_version": version, "session_id": st.session_id}

    def _semantic_results(st, req: ConsultRequest) -> tuple[list, list]:
        if not st.semantic_available:
            raise HTTPException(503, st.semantic_unavailable_reason)
        qvec = np.asarray(st.embedder([req.line]), dtype=np.float32)[0]
        scores = st.vectors @ qvec
        order = sorted(range(len(scores)),
                       key=lambda i: (-float(scores[i]), st.vector_ids[i]))
        draft_lines = set(req.draft_text.split("\n"))
        results, suppressed = [], []
        per_source: dict[str, int] = {}
        for rank_raw, i in enumerate(order, start=1):
            if len(results) >= config.K_SEMANTIC:
                break
            iid = st.vector_ids[i]
            item = st.items_by_id.get(iid, {})
            source_id = item.get("source_id") or iid
            score = round(float(scores[i]), 6)
            if per_source.get(source_id, 0) >= config.MAX_PER_SOURCE:
                suppressed.append({
                    "item_id": iid, "score": score, "rank_raw": rank_raw,
                    "source_id": source_id, "reason": "source_cap",
                })
                continue
            per_source[source_id] = per_source.get(source_id, 0) + 1
            results.append({
                "item_id": iid,
                "rank": len(results) + 1,
                "rank_raw": rank_raw,
                "score": score,
                "item_type": item.get("item_type"),
                "source_id": source_id,
                "in_draft": item.get("display_text") in draft_lines,
            })
        return results, suppressed

    @app.post("/draft")
    async def draft(req: DraftRequest):
        stored = _draft()
        before = app.state.poem_version
        version, _ = _record_poem(req.title, req.text, "autosave")
        changed = version != before

        stored_by_id = {n["id"]: n for n in stored["annotations"]}
        incoming = [n.model_dump() for n in req.annotations
                    if n.id in stored_by_id]
        incoming_ids = {n["id"] for n in incoming}
        for n in incoming:
            old = stored_by_id.get(n["id"])
            if old and (old.get("line_index") != n["line_index"]
                        or old.get("status") != n["status"]):
                _log(app, "line_note_reanchored", {
                    "note_id": n["id"],
                    "from_index": old.get("line_index"),
                    "to_index": n["line_index"],
                    "from_status": old.get("status"),
                    "to_status": n["status"],
                    "line_text": n["line_text"],
                })
        merged = incoming + [n for nid, n in stored_by_id.items()
                             if nid not in incoming_ids]
        _write_json(draft_path, {"title": req.title, "text": req.text,
                                 "annotations": merged})
        _log(app, "draft_saved", {
            "version": version, "chars": len(req.text),
            "lines": len(req.text.split("\n")) if req.text else 0,
            "notes": len(merged), "client_ts": req.client_ts,
        })
        return {"ok": True, "poem_version": version, "changed": changed}

    @app.post("/line_note")
    async def line_note(req: LineNoteRequest):
        st = app.state
        if req.action not in NOTE_ACTIONS:
            raise HTTPException(422, "action must be create, edit, attach or delete")
        if req.note.status not in NOTE_STATUSES:
            raise HTTPException(422, "status must be anchored or orphaned")
        version, phash = _record_poem(req.title, req.draft_text, "line_note")
        stored = _draft()
        notes = [n for n in stored["annotations"] if n["id"] != req.note.id]
        now = _utcnow().isoformat()
        note = req.note.model_dump()
        if req.action != "delete":
            prev = next((n for n in stored["annotations"]
                         if n["id"] == req.note.id), None)
            note["created_ts"] = (prev or {}).get("created_ts") \
                or note.get("created_ts") or now
            note["updated_ts"] = now
            note["created_poem_version"] = (prev or {}).get(
                "created_poem_version") or note.get("created_poem_version") \
                or version
            note["created_consult_id"] = (prev or {}).get(
                "created_consult_id") or note.get("created_consult_id") \
                or req.consult_id
            notes.append(note)
        _write_json(draft_path, {"title": req.title, "text": req.draft_text,
                                 "annotations": notes})
        lc = st.last_consult if (st.last_consult and req.consult_id
                                 == st.last_consult["consult_id"]) else None
        _log(app, "line_note", {
            "action": req.action,
            "note_id": note["id"],
            "line_index": note["line_index"],
            "line_text": note["line_text"],
            "text": note["text"],
            "status": note["status"],
            "anchor_text": note.get("anchor_text", ""),
            "created_ts": note.get("created_ts"),
            "updated_ts": note.get("updated_ts"),
            "created_poem_version": note.get("created_poem_version"),
            "created_consult_id": note.get("created_consult_id"),
            "poem_hash": phash,
            "consult_id": req.consult_id,
            "consult_line": lc["line"] if lc else None,
            "consult_line_index": lc["line_index"] if lc else None,
            "panel_item": req.panel_item,
            "client_ts": req.client_ts,
        })
        return {"ok": True, "annotations": notes, "poem_version": version}

    @app.post("/pin")
    async def pin(req: PinRequest):
        st = app.state
        if req.origin not in PIN_ORIGINS:
            raise HTTPException(422, "origin must be field, panel or tray")
        if req.item_id not in st.items_by_id:
            raise HTTPException(404, f"unknown item {req.item_id}")
        pins = [p for p in _pins() if p["item_id"] != req.item_id]
        entry = {
            "item_id": req.item_id,
            "session_id": st.session_id,
            "consult_id": req.consult_id,
            "rank": req.rank,
            "rank_raw": req.rank_raw,
            "score": req.score,
            "query_line": req.query_line,
            "line_index": req.line_index,
            "origin": req.origin,
            "poem_version": st.poem_version,
            "pinned_ts": _utcnow().isoformat(),
        }
        pins.append(entry)
        _write_json(pins_path, pins)
        _log(app, "pin", {k: v for k, v in entry.items()
                          if k not in ("session_id", "poem_version")}
             | {"client_ts": req.client_ts})
        return {"ok": True, "pins": pins}

    @app.post("/unpin")
    async def unpin(req: UnpinRequest):
        pins = _pins()
        existing = next((p for p in pins if p["item_id"] == req.item_id), None)
        pins = [p for p in pins if p["item_id"] != req.item_id]
        _write_json(pins_path, pins)
        _log(app, "unpin", {
            "item_id": req.item_id, "origin": req.origin,
            "pinned_consult_id": existing.get("consult_id") if existing else None,
            "client_ts": req.client_ts,
        })
        return {"ok": True, "pins": pins}

    @app.post("/event")
    async def event(req: EventRequest):
        st = app.state
        if req.type not in config.CLIENT_EVENTS:
            raise HTTPException(422, f"unknown event type {req.type!r}")
        reserved = sorted(set(req.payload) & ENVELOPE_KEYS)
        if reserved:
            raise HTTPException(422, f"payload uses reserved keys {reserved}")
        key = None
        if req.page_id is not None and req.client_seq is not None:
            key = (req.page_id, req.client_seq)
            if key in st.seen_client_rows:
                return {"ok": True, "duplicate": True}
        payload = dict(req.payload)
        payload["client_ts"] = req.client_ts
        payload["client_seq"] = req.client_seq
        payload["page_id"] = req.page_id
        if req.type == "session_end" and st.session_ended:
            payload["already_ended"] = True
            _log(app, req.type, payload)
            if key is not None:
                st.seen_client_rows.add(key)
            return {"ok": True, "already_ended": True, "export": None}
        if req.type == "session_end":
            d = _draft()
            _record_poem(d["title"], d["text"], "session_end")
            payload["pins"] = [p.get("item_id") for p in _pins()]
            payload["notes"] = len(d["annotations"])
            payload["consults"] = st.session["consult_seq"]
            st.session["ended_utc"] = _utcnow().isoformat()
            _save_session()
        _log(app, req.type, payload)
        if key is not None:
            st.seen_client_rows.add(key)
        if req.type == "session_end":
            st.session_ended = True
            return {"ok": True, "export": _export_session()}
        return {"ok": True}

    def _export_session() -> dict | None:
        st = app.state
        try:
            import export as _export
            files = _export.write_bundle(research_dir, data_dir, st.session_id)
            info = {
                "exported_session_id": st.session_id,
                "path": str(files[0].parent),
                "files": [f.name for f in files],
                "bytes": sum(f.stat().st_size for f in files),
            }
            _log(app, "export", info)
            return info
        except Exception as exc:
            _log(app, "export_error", {"error": repr(exc)})
            return None

    @app.post("/session_note")
    async def session_note(req: SessionNoteRequest):
        _log(app, "session_note", {"text": req.text})
        return {"ok": True}

    @app.post("/reflection")
    async def reflection(req: ReflectionRequest):
        st = app.state
        if req.consult_id not in st.session.get("consult_ids", []):
            raise HTTPException(422, "consult_id is not a consult of this session")
        version, phash = _record_poem(req.title, req.draft_text, "reflection")
        refl = st.session.setdefault("reflections", {})
        text = req.text.strip()
        existed = req.consult_id in refl
        if text:
            action = "edit" if existed else "create"
            refl[req.consult_id] = text
        elif existed:
            action = "delete"
            del refl[req.consult_id]
        else:
            return {"ok": True, "reflections": refl, "poem_version": version}
        _save_session()
        lc = st.last_consult if (st.last_consult and st.last_consult["consult_id"]
                                 == req.consult_id) else None
        _log(app, "cycle_reflection", {
            "consult_id": req.consult_id,
            "action": action,
            "text": text,
            "poem_hash": phash,
            "consult_line": lc["line"] if lc else None,
            "consult_line_index": lc["line_index"] if lc else None,
            "client_ts": req.client_ts,
        })
        return {"ok": True, "reflections": refl, "poem_version": version}

    @app.post("/session/new")
    async def session_new(req: NewSessionRequest):
        st = app.state
        if not st.session_ended:
            raise HTTPException(409, "end the current session first")
        previous = st.session_id
        draft = _draft()
        if req.clear_poem:
            draft = {"title": "", "text": "", "annotations": []}
            _write_json(draft_path, draft)
        _begin_session(_new_session_dict(_utcnow(), previous), draft, _pins(),
                       resumed=False, extra={
                           "poem_cleared": bool(req.clear_poem),
                           "previous_session_id": previous,
                           "client_ts": req.client_ts})
        return {"ok": True, "session": _session_view()}

    return app


app = create_app()
