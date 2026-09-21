from __future__ import annotations

MODEL_KEY = "placeholder"
MODEL_NAMES = {"placeholder": "MODEL_PLACEHOLDER"}

#Retrieval limits apply after scoring.
K_SEMANTIC = 10
MAX_PER_SOURCE = 2
QUERY_FORM = "bare"

SOURCE_XLSX = "archive.xlsx"
ARCHIVE_SHEET = "Embedding_Archive"
ARCHIVE_VERSION = "unconfigured"
ARCHIVE_WORKBOOK_SHA256 = ""
ARCHIVE_ITEM_COUNT = None
ITEM_TYPES = ("poetry", "prose_excerpt", "note", "fragment")

SCHEMA_VERSION = 3
CONSULT_TRIGGERS = ("keyboard", "gutter")
CLIENT_EVENTS = (
    "page_load", "consult_displayed", "consult_discarded", "consult_failed",
    "field_relayout", "peek", "open_item", "field_view", "pin_tray_toggle",
    "annotated_view", "source_expanded", "help_open", "page_hide", "page_conflict",
    "session_end",
)
