# Poemarium

Source for two iterations of a local poetry-writing workspace.

Both start empty. The archive, poems, annotations, session records, embeddings, model implementations and prompt text are not included, so retrieval, Connect and Reframe stay unavailable until you supply them.

## The two iterations

**`iteration1/`** contains the poem editor, archive field, item reader, pinned material, line annotations and session recording. Retrieval ranks by cosine similarity, returns up to ten items and allows at most two per source.

**`iteration2/`** keeps the same workspace and adds an explicit session start, Connect over one to three chosen items, Reframe on the opened item, recurrence lookup and optional session-note fields.

They are separate applications.

## Run

Python 3.11 or later, macOS or Linux. From the repository root:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

Iteration 1:

```bash
python -m uvicorn app:app --app-dir iteration1 --host 127.0.0.1 --port 8000
```

Iteration 2, in a second terminal with the same environment active:

```bash
python -m uvicorn app:app --app-dir iteration2 --host 127.0.0.1 --port 8001
```

Open `http://127.0.0.1:8000` and `http://127.0.0.1:8001`. In Iteration 2, select **Start session** first.

Both are for local, single-user use. There is no authentication; do not expose either as a public service.

## Without an archive or model

Writing, line annotations, draft saving and session export all work. Iteration 1 opens a session on launch; Iteration 2 waits for an explicit start.

To go further, supply your own:

- `model.py`: embedding placeholders (`get_model`, `embed_texts`). `embed_texts` should return unit-length vectors, because scoring is a dot product. Retrieval also needs archive data and matching embeddings.
- `iteration2/mediation.py`: a provider interface taking an action name and structured input. The bundled placeholder reports that no model is configured. Connect and Reframe stay disabled until it is replaced.
- `ingest.py`: the workbook schema and archive preparation functions.

No model weights, credentials or external model services are included, and no role instructions or response templates are supplied. `app.py` holds the server and routes; `export.py` rebuilds sessions from the local records. The interface is plain HTML, CSS and JavaScript with no build step, using locally installed fonts or system fallbacks.

## Where files go

Records are written to `iteration1/research/iteration1/` and `iteration2/research/iteration2/`. Archive files belong in each iteration's `data/`. `POETRY_DATA_DIR` and `POETRY_RESEARCH_DIR` override both. Keep the two research directories separate.

Iteration 2 can read selected Iteration 1 sessions for recurrence lookup; that selection is empty by default.

`.gitignore` excludes the data and research directories, exports, spreadsheets, model files, prompt files, local settings and caches. Anything saved outside those paths needs its own rule.
