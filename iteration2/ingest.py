from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
from pathlib import Path

import openpyxl

import config
from model import embed_texts, get_model, model_revision

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_XLSX = BASE_DIR / config.SOURCE_XLSX
DEFAULT_DATA_DIR = BASE_DIR / "data"

ARCHIVE_COLUMNS = (
    "item_id", "item_type", "embedding_text", "display_text", "source_id",
    "source_title", "creator", "authorship", "source_date", "source_language",
    "display_language", "source_file", "source_kind", "provenance",
    "use_for_retrieval",
)
README_SHA_LABEL = "Archive content SHA-256"
README_COUNT_LABEL = "Frozen retrieval units"


class WorkbookVerificationError(RuntimeError):
    pass


def cell_str(v) -> str:
    if v is None:
        return ""
    if isinstance(v, _dt.datetime):
        return v.strftime("%Y.%m.%d")
    if isinstance(v, _dt.date):
        return v.strftime("%Y.%m.%d")
    return str(v)


def parse_bool(value, item_id: str) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(value)
    if value is None:
        return False
    if isinstance(value, str):
        s = value.strip().lower()
        if s in ("true", "1", "yes", "y"):
            return True
        if s in ("false", "0", "no", "n", ""):
            return False
    raise ValueError(
        f"unparseable use_for_retrieval {value!r} for item {item_id}")


def workbook_content_sha256(rows, ncols: int = len(ARCHIVE_COLUMNS)) -> str:
    def cells(row):
        row = list(row)[:ncols] + [None] * max(0, ncols - len(row))
        return "\t".join("" if c is None else str(c) for c in row)
    return hashlib.sha256(
        "\n".join(cells(r) for r in rows).encode("utf-8")).hexdigest()


def read_readme(wb) -> dict:
    out = {}
    if "README" not in wb.sheetnames:
        return out
    for row in wb["README"].iter_rows(values_only=True):
        if row and row[0] is not None and len(row) > 1:
            out[cell_str(row[0]).strip()] = cell_str(row[1]).strip()
    return out


def verify_workbook(readme: dict, data_rows: list, ncols: int) -> dict:
    recomputed = workbook_content_sha256(data_rows, ncols)
    readme_sha = readme.get(README_SHA_LABEL, "")
    readme_count = readme.get(README_COUNT_LABEL, "")
    failures = []
    if readme_sha and recomputed != readme_sha:
        failures.append("workbook content does not match the README checksum")
    if config.ARCHIVE_WORKBOOK_SHA256 and recomputed != config.ARCHIVE_WORKBOOK_SHA256:
        failures.append("workbook content does not match the configured checksum")
    if readme_count:
        try:
            count = float(readme_count)
        except ValueError:
            count = -1
        if count != len(data_rows):
            failures.append("workbook row count does not match the README")
    if config.ARCHIVE_ITEM_COUNT is not None and len(data_rows) != config.ARCHIVE_ITEM_COUNT:
        failures.append("workbook row count does not match the configured count")
    if failures:
        raise WorkbookVerificationError("; ".join(failures))
    return {"workbook_sha256": recomputed, "workbook_units": len(data_rows)}


def compute_archive_hash(items: list[dict], sources: dict | None = None) -> str:
    canonical = {"items": sorted(items, key=lambda x: x["item_id"]),
                 "sources": sources or {}}
    payload = json.dumps(canonical, sort_keys=True, separators=(",", ":"),
                         ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def read_sources(wb, poem_ids: set) -> dict:
    if "Poem_Sources" not in wb.sheetnames:
        return {}
    rows = list(wb["Poem_Sources"].iter_rows(values_only=True))
    if not rows:
        return {}
    header = [cell_str(c) for c in rows[0]]
    need = ("poem_id", "poem_label_en", "date", "full_text_en")
    missing = [c for c in need if c not in header]
    if missing:
        raise WorkbookVerificationError(
            f"Poem_Sources is missing columns {missing}")
    col = {name: i for i, name in enumerate(header)}
    out = {}
    for r in rows[1:]:
        if not r:
            continue
        pid = cell_str(r[col["poem_id"]])
        text = cell_str(r[col["full_text_en"]])
        if pid and pid in poem_ids and text.strip():
            out[pid] = {"title": cell_str(r[col["poem_label_en"]]),
                        "date": cell_str(r[col["date"]]),
                        "text": text}
    return out


def build_archive(xlsx_path: str | Path = DEFAULT_XLSX) -> dict:
    wb = openpyxl.load_workbook(str(xlsx_path), data_only=True,
                                read_only=True)
    try:
        if config.ARCHIVE_SHEET not in wb.sheetnames:
            raise WorkbookVerificationError(
                f"sheet {config.ARCHIVE_SHEET!r} missing from {xlsx_path}")
        ws = wb[config.ARCHIVE_SHEET]
        rows = list(ws.iter_rows(values_only=True))
        if not rows:
            raise WorkbookVerificationError("archive sheet is empty")
        header = [cell_str(c) for c in rows[0]]
        missing = [c for c in ARCHIVE_COLUMNS if c not in header]
        if missing:
            raise WorkbookVerificationError(
                f"Embedding_Archive is missing columns {missing}")
        col = {name: i for i, name in enumerate(header)}

        data_rows = [r for r in rows[1:] if r and r[col["item_id"]] is not None
                     and cell_str(r[col["item_id"]]) != ""]
        stamps = verify_workbook(read_readme(wb), data_rows, len(header))

        items = []
        seen = set()
        for row in data_rows:
            item_id = cell_str(row[col["item_id"]])
            if item_id in seen:
                raise WorkbookVerificationError(f"duplicate item_id {item_id}")
            seen.add(item_id)
            it = {name: cell_str(row[col[name]]) for name in ARCHIVE_COLUMNS
                  if name != "use_for_retrieval"}
            it["use_for_retrieval"] = parse_bool(row[col["use_for_retrieval"]],
                                                 item_id)
            if it["item_type"] not in config.ITEM_TYPES:
                raise WorkbookVerificationError(
                    f"{item_id}: unknown item_type {it['item_type']!r}")
            if not it["display_text"].strip():
                raise WorkbookVerificationError(f"{item_id}: empty display_text")
            if it["embedding_text"] != it["display_text"]:
                raise WorkbookVerificationError(
                    f"{item_id}: embedding_text != display_text (README rule: "
                    "metadata is never concatenated into the embedding)")
            if not it["use_for_retrieval"]:
                raise WorkbookVerificationError(
                    f"{item_id}: use_for_retrieval must be True")
            items.append(it)

        sources = read_sources(
            wb, {it["source_id"] for it in items if it["source_kind"] == "own_poem"})
        counts = {
            "by_type": _count(items, "item_type"),
            "by_source_kind": _count(items, "source_kind"),
            "by_authorship": _count(items, "authorship"),
            "sources": len({it["source_id"] for it in items}),
            "poems_with_full_text": len(sources),
        }
        return {
            "archive_format": 3,
            "archive_version": config.ARCHIVE_VERSION,
            "archive_hash": compute_archive_hash(items, sources),
            "workbook_sha256": stamps["workbook_sha256"],
            "generated_utc": _dt.datetime.now(_dt.timezone.utc).isoformat(),
            "source_file": Path(xlsx_path).name,
            "sheet": config.ARCHIVE_SHEET,
            "item_count": len(items),
            "counts": counts,
            "items": items,
            "sources": sources,
        }
    finally:
        wb.close()


def _count(items: list[dict], key: str) -> dict:
    out: dict[str, int] = {}
    for it in items:
        out[it[key]] = out.get(it[key], 0) + 1
    return dict(sorted(out.items()))


def write_archive(archive: dict, data_dir: str | Path = DEFAULT_DATA_DIR) -> Path:
    data_dir = Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(archive, ensure_ascii=False, indent=1)
    out = data_dir / "archive.json"
    out.write_text(payload, encoding="utf-8")

    versions_dir = data_dir / "versions"
    versions_dir.mkdir(parents=True, exist_ok=True)
    versioned = versions_dir / f"archive_{archive['archive_hash'][:8]}.json"
    if not versioned.exists():
        versioned.write_text(payload, encoding="utf-8")
    return out


def write_embeddings(archive: dict, model_key: str = config.MODEL_KEY,
                     data_dir: str | Path = DEFAULT_DATA_DIR, model=None) -> Path:
    import numpy as np
    if model is None:
        model = get_model(model_key)
    rows = [it for it in archive["items"] if it["use_for_retrieval"]]
    vectors = embed_texts(model, [it["embedding_text"] for it in rows])
    data_dir = Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    out = data_dir / f"embeddings_{model_key}.npz"
    np.savez(
        out,
        vectors=vectors,
        item_ids=np.array([it["item_id"] for it in rows]),
        model_name=config.MODEL_NAMES[model_key],
        model_revision=model_revision(model),
        archive_hash=archive["archive_hash"],
        workbook_sha256=archive["workbook_sha256"],
    )
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="Build a local archive from a workbook.")
    ap.add_argument("--xlsx", default=str(DEFAULT_XLSX))
    ap.add_argument("--data-dir", default=str(DEFAULT_DATA_DIR))
    ap.add_argument("--embed", action="store_true",
                    help="also compute the configured model's embeddings")
    args = ap.parse_args(argv)

    archive = build_archive(args.xlsx)
    out = write_archive(archive, args.data_dir)
    print(f"verified workbook {archive['workbook_sha256'][:12]}… "
          f"({archive['archive_version']}, {archive['item_count']} units)")
    print(f"wrote {out}  (archive_hash {archive['archive_hash'][:8]}, "
          f"types {archive['counts']['by_type']}, "
          f"{len(archive['sources'])} own poems with full text)")

    if args.embed:
        path = write_embeddings(archive, config.MODEL_KEY, args.data_dir)
        print(f"wrote {path}")


#Use the same schema for an empty workspace.
def empty_archive() -> dict:
    return {
        "archive_format": 3,
        "archive_version": config.ARCHIVE_VERSION,
        "archive_hash": compute_archive_hash([], {}),
        "workbook_sha256": "",
        "item_count": 0,
        "counts": {},
        "items": [],
        "sources": {},
    }


if __name__ == "__main__":
    main()
