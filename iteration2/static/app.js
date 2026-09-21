'use strict';

const $ = (s) => document.querySelector(s);
const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function svg(tag, attrs) {
  const n = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const k of Object.keys(attrs)) n.setAttribute(k, String(attrs[k]));
  return n;
}

//Read workspace state from the local server.
async function apiGet(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(path + ' -> ' + r.status);
  return r.json();
}

async function apiPost(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = new Error(path + ' -> ' + r.status);
    err.status = r.status;
    try { err.detail = (await r.json()).detail; } catch (e) {               }
    throw err;
  }
  return r.json();
}

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  const b = new Uint8Array(4);
  (window.crypto || {}).getRandomValues ? window.crypto.getRandomValues(b)
    : b.forEach((_, i) => { b[i] = Math.floor(Math.random() * 256); });
  return prefix + '_' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function softTruncate(s, n) {
  s = String(s);
  if (s.length <= n) return s;
  const cut = s.lastIndexOf(' ', n - 1);
  const head = s.slice(0, cut > n / 2 ? cut : n - 1);
  return head.replace(/[\s,;:.—-]+$/, '') + '…';
}

function firstLine(s) {
  return String(s).split('\n')[0];
}

const TYPE_LABELS = {
  poetry: 'poetry',
  prose_excerpt: 'prose',
  note: 'note',
  fragment: 'fragment',
};

function typeWord(type) {
  return TYPE_LABELS[type] || type || 'item';
}

function itemText(item, fallback) {
  return item ? item.display_text : fallback;
}

const state = {
  itemsById: new Map(),
  pins: [],
  notes: [],
  consulting: null,
  consult: null,
  selected: null,
  caretIndex: 0,
  zoom: 1,
  peeked: new Set(),
  session: null,
  runId: null,
  pageId: randomId('pg'),
  clientSeq: 0,
  prevText: '',
  annotated: false,
  notePop: null,
  noteDrafts: new Map(),
  panelMode: 'column',
  ended: false,
  fieldUnavailable: false,
  noteSentText: null,
  readOnlyConflict: false,
  sources: {},
  sourceShown: null,
  otherPageId: null,
  reflections: {},
  reflectDraft: null,
  mediationAvailable: false,
  mediations: [],
  mediating: null,
  connectPicks: [],
  noSession: false,
};

let consultSeq = 0;

function isPinned(itemId) {
  return state.pins.some((p) => p.item_id === itemId);
}

function pinFor(itemId) {
  return state.pins.find((p) => p.item_id === itemId) || null;
}

function consultId() {
  return state.consult ? state.consult.consult_id : null;
}

const eventQueue = [];
let eventFlushTimer = null;
let wasOffline = false;

function jsonBlob(body) {
  return new Blob([JSON.stringify(body)], { type: 'application/json' });
}

function scheduleEventFlush() {
  if (eventFlushTimer) return;
  eventFlushTimer = setTimeout(async () => {
    eventFlushTimer = null;
    const pending = eventQueue.splice(0);
    for (const body of pending) {
      try {
        await apiPost('/event', body);
        setOnline();
      } catch (e) {
        if (e.status === 422) continue;
        eventQueue.push(body);
      }
    }
    if (eventQueue.length) scheduleEventFlush();
  }, 5000);
}

function eventBody(type, payload) {
  return {
    type,
    payload: payload || {},
    client_ts: nowIso(),
    client_seq: ++state.clientSeq,
    page_id: state.pageId,
  };
}

function postEvent(type, payload) {
  const body = eventBody(type, payload);
  apiPost('/event', body)
    .then(setOnline)
    .catch((e) => {
      if (e.status === 422) return;
      setOffline();
      eventQueue.push(body);
      scheduleEventFlush();
    });
}

function setOnline() {
  $('#status-bar').classList.remove('offline');
  if (wasOffline) {
    wasOffline = false;
    resyncAfterReconnect();
  }
}
function setOffline() {
  wasOffline = true;
  $('#status-bar').classList.add('offline');
}

async function resyncAfterReconnect() {
  try {
    const st = await apiGet('/state');
    const restarted = st.run_id !== state.runId;
    state.runId = st.run_id;
    state.session = st.session;
    state.pins = st.pins || [];
    state.reflections = (st.session && st.session.reflections) || state.reflections;
    renderReflectToggle();
    renderPins();
    refreshItemPin();
    renderStatus(st.config || {});
    if (restarted) postEvent('page_load', pageLoadPayload('reconnect'));
  } catch (e) {                                               }
}

const ta = $('#draft');
const titleEl = $('#title');
const gutterInner = $('#gutter-inner');
const caretLineEl = $('#caret-line');
const consultBandEl = $('#consult-band');

let LH = 30;
let PAD_TOP = 18;

function measureEditor() {
  const cs = getComputedStyle(ta);
  const lh = parseFloat(cs.lineHeight);
  const pt = parseFloat(cs.paddingTop);
  if (Number.isFinite(lh) && lh > 0) LH = lh;
  if (Number.isFinite(pt)) PAD_TOP = pt;
}

function lines() {
  return ta.value.split('\n');
}

function currentLineIndex() {
  return ta.value.slice(0, ta.selectionStart).split('\n').length - 1;
}

function lineStartOffset(index) {
  const ls = lines();
  let off = 0;
  for (let i = 0; i < index && i < ls.length; i++) off += ls[i].length + 1;
  return off;
}

function moveCaretToLine(index) {
  const off = lineStartOffset(index);
  ta.focus();
  ta.setSelectionRange(off, off);
  updateCaret();
}

function updateLineCount() {
  const n = lines().filter((l) => l.trim()).length;
  $('#line-count').textContent = n + (n === 1 ? ' line' : ' lines');
}

function noteAt(index) {
  return state.notes.find((n) => n.status === 'anchored' && n.line_index === index) || null;
}

function orphanNotes() {
  return state.notes.filter((n) => n.status !== 'anchored');
}

function rebuildGutter() {
  gutterInner.textContent = '';
  const ls = lines();
  const c = state.consulting;
  ls.forEach((line, i) => {
    if (!line.trim()) return;
    const top = PAD_TOP + i * LH + LH / 2 + 'px';

    const nb = el('button', 'gutter-note');
    nb.type = 'button';
    nb.dataset.line = String(i);
    nb.style.top = top;
    const existing = noteAt(i);
    if (existing) nb.classList.add('has-note');
    nb.title = existing ? 'edit the note on this line' : 'write a note on this line';
    nb.setAttribute('aria-label', (existing ? 'Edit note on line ' : 'Note on line ') + (i + 1));
    nb.addEventListener('click', () => openNotePopover(i));
    gutterInner.appendChild(nb);

    const b = el('button', 'gutter-dot');
    b.type = 'button';
    b.dataset.line = String(i);
    b.style.top = top;
    b.title = 'consult the archive with this line';
    b.setAttribute('aria-label', 'Consult line ' + (i + 1));
    b.addEventListener('click', () => {
      moveCaretToLine(i);
      consultLine(i, 'gutter');
    });
    if (c && c.status !== 'lost' && c.index === i) {
      b.classList.add('consulted');
      if (c.status === 'edited') b.classList.add('edited');
    }
    gutterInner.appendChild(b);
  });
  updateLineCount();
  updateCaret();
  renderDetachedCount();
}

function updateCaret() {
  state.caretIndex = currentLineIndex();
  caretLineEl.hidden = false;
  caretLineEl.style.height = LH + 'px';
  caretLineEl.style.top = PAD_TOP + state.caretIndex * LH - ta.scrollTop + 'px';
  const c = state.consulting;
  if (c && c.status !== 'lost') {
    consultBandEl.hidden = false;
    consultBandEl.style.height = LH + 'px';
    consultBandEl.style.top = PAD_TOP + c.index * LH - ta.scrollTop + 'px';
  } else {
    consultBandEl.hidden = true;
  }
  for (const d of gutterInner.children) {
    d.classList.toggle('active', Number(d.dataset.line) === state.caretIndex);
  }
  if (state.notePop && state.notePop.mode === 'line') positionNotePopover();
}

function syncScroll() {
  gutterInner.style.transform = 'translateY(' + -ta.scrollTop + 'px)';
  updateCaret();
}

let saveTimer = null;
let saveRetryTimer = null;
let saveInFlight = null;
let draftLoaded = false;
let draftDirty = false;

function draftBody() {
  return { title: titleEl.value, text: ta.value, annotations: state.notes,
    client_ts: nowIso() };
}

function postDraft() {
  draftDirty = false;
  const p = apiPost('/draft', draftBody())
    .then((out) => { setOnline(); return out; })
    .catch((e) => {
      draftDirty = true;
      if (e.status === 422) {
        flashNote('this text could not be saved — unusual characters?');
        return null;
      }
      setOffline();

      if (!saveRetryTimer) {
        saveRetryTimer = setTimeout(() => {
          saveRetryTimer = null;
          if (draftDirty) scheduleSave();
        }, 5000);
      }
      return null;
    })
    .finally(() => { if (saveInFlight === p) saveInFlight = null; });
  saveInFlight = p;
  return p;
}

function scheduleSave() {
  if (!draftLoaded || state.readOnlyConflict || state.noSession) return;
  draftDirty = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    postDraft();
  }, 1000);
}

async function flushDraftSave() {
  if (!draftLoaded) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (saveRetryTimer) { clearTimeout(saveRetryTimer); saveRetryTimer = null; }
  if (saveInFlight) await saveInFlight;
  if (draftDirty) {
    draftDirty = false;
    try {
      await apiPost('/draft', draftBody());
    } catch (e) {
      draftDirty = true;
      throw e;
    }
  }
}

function onDraftInput() {
  const next = ta.value;
  if (next !== state.prevText) {
    state.notes = Anchor.reanchorNotes(state.prevText, next, state.notes);
    if (state.consulting) reanchorConsulting(state.prevText, next);
    trackNotePopover(state.prevText, next);
    state.prevText = next;
  }
  rebuildGutter();
  renderConsultStrip();
  scheduleSave();
}

function trackNotePopover(oldText, newText) {
  const d = Anchor.diffLines(oldText, newText);
  if (!d) return;
  const shifted = new Map();
  for (const [k, v] of state.noteDrafts) {
    if (k < d.a) shifted.set(k, v);
    else if (k > d.b) shifted.set(k + (d.c - d.b), v);
    else if (d.a === d.b) shifted.set(k, v);
  }
  state.noteDrafts = shifted;
  const np = state.notePop;
  if (!np || np.mode !== 'line') return;
  const moved = Anchor.reanchorOne(oldText, newText,
    { index: np.index, text: np.lineText, anchor_text: np.anchorText, status: 'anchored' });
  if (moved.status === 'orphaned') {
    closeNotePopover(true);
    flashNote('the line under the note was removed — the note text is kept');
    return;
  }
  np.index = moved.index;
  np.lineText = moved.text;
  $('#note-pop-line').textContent = 'line ' + (np.index + 1) + ' · ' + np.lineText;
}

function setDraftText(text) {
  ta.value = text;
  state.prevText = text;
  state.notes = Anchor.reconcile(text, state.notes);
}

ta.addEventListener('input', onDraftInput);
ta.addEventListener('scroll', syncScroll);
ta.addEventListener('click', updateCaret);
ta.addEventListener('keyup', updateCaret);
document.addEventListener('selectionchange', () => {
  if (document.activeElement === ta) updateCaret();
});
titleEl.addEventListener('input', scheduleSave);

ta.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    consultLine(currentLineIndex(), 'keyboard');
  } else if ((e.metaKey || e.ctrlKey) && e.key === '/') {
    e.preventDefault();
    openNotePopover(currentLineIndex());
  }
});

let flashTimer = null;
function flashNote(msg) {
  const f = $('#flash-note');
  f.textContent = msg;
  f.hidden = false;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    f.hidden = true;
  }, 2200);
}

function reanchorConsulting(oldText, newText) {
  const c = state.consulting;
  const moved = Anchor.reanchorOne(oldText, newText, {
    index: c.index, text: c.text, anchor_text: c.consultedText,
    status: c.status === 'lost' ? 'orphaned' : 'anchored',
  });
  c.index = moved.index;
  c.text = moved.text;
  if (moved.status === 'orphaned') c.status = 'lost';
  else c.status = moved.text === c.consultedText ? 'anchored' : 'edited';
}

function renderConsultStrip() {
  const c = state.consulting;
  const lineEl = $('#consulted-line');
  const statusEl = $('#consult-status');
  statusEl.textContent = '';
  if (!c) {
    lineEl.textContent = ' ';
    lineEl.classList.remove('lost');
    statusEl.hidden = true;
    return;
  }
  lineEl.textContent = c.status === 'lost' ? c.consultedText : (c.text || ' ');
  lineEl.classList.toggle('lost', c.status === 'lost');
  if (c.status === 'edited') {
    statusEl.textContent = 'edited since — the field still answers the line as it was: “' + truncate(c.consultedText, 60) + '”';
    statusEl.hidden = false;
  } else if (c.status === 'lost') {
    statusEl.textContent = 'this line is no longer in the poem — the field still shows what it answered';
    statusEl.hidden = false;
  } else if (c.status === 'pending') {
    statusEl.textContent = 'consulting…';
    statusEl.hidden = false;
  } else {
    statusEl.hidden = true;
  }
}

function renderReflectToggle() {
  const btn = $('#reflect-toggle');
  const cid = consultId();
  if (!cid) {
    btn.hidden = true;
    $('#reflect-box').hidden = true;
    return;
  }
  btn.hidden = false;
  const has = !!((state.reflections[cid] || '').trim());
  btn.textContent = has ? 'reflection ✓' : 'reflect on this cycle';
  btn.classList.toggle('has-reflection', has);
}

function openReflectBox() {
  const cid = consultId();
  if (!cid) return;
  const box = $('#reflect-box');
  const t = $('#reflect-text');
  box.hidden = false;
  $('#reflect-toggle').setAttribute('aria-expanded', 'true');
  t.value = state.reflectDraft && state.reflectDraft.cid === cid
    ? state.reflectDraft.text : (state.reflections[cid] || '');
  t.focus();
}

function closeReflectBox(keepDraft) {
  const box = $('#reflect-box');
  if (box.hidden) return;
  const cid = consultId();
  const v = $('#reflect-text').value;
  if (keepDraft && cid && v !== (state.reflections[cid] || '')) state.reflectDraft = { cid, text: v };
  else state.reflectDraft = null;
  box.hidden = true;
  $('#reflect-toggle').setAttribute('aria-expanded', 'false');
  ta.focus();
}

async function saveReflection() {
  const cid = consultId();
  if (!cid || readOnlyGuard()) return;
  const text = $('#reflect-text').value.trim();
  try {
    await flushDraftSave();
    const out = await apiPost('/reflection', {
      consult_id: cid, text, title: titleEl.value, draft_text: ta.value, client_ts: nowIso(),
    });
    setOnline();
    state.reflections = out.reflections || state.reflections;
    state.reflectDraft = null;
    closeReflectBox(false);
    renderReflectToggle();
  } catch (e) {
    setOffline();
    flashNote('could not save the reflection — it is kept here, try again');
  }
}

$('#reflect-toggle').addEventListener('click', () => {
  if ($('#reflect-box').hidden) openReflectBox();
  else closeReflectBox(true);
});
$('#reflect-save').addEventListener('click', saveReflection);
$('#reflect-text').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    saveReflection();
  }
});

function readOnlyGuard() {
  if (state.noSession) {
    flashNote('start a session first — nothing is recorded until then');
    return true;
  }
  if (state.ended) {
    flashNote('this session has ended — start a new one to continue');
    return true;
  }
  if (!state.readOnlyConflict) return false;
  flashNote('this window only reads — click “write here instead” to write here');
  return true;
}

function consultLine(index, trigger) {
  if (readOnlyGuard()) return;
  const line = lines()[index];
  if (line === undefined || !line.trim()) {
    flashNote('a blank line cannot be consulted');
    return;
  }
  const previous = state.consulting;
  state.consulting = { index, text: line, consultedText: line, consult_id: null, status: 'pending' };
  rebuildGutter();
  renderConsultStrip();
  runConsult(trigger, previous);
}

function showFieldUnavailable(reason) {
  const msg = document.querySelector('#view-field .placeholder');
  if (msg) {
    msg.textContent = reason || 'Archive data and an embedding model are not included in this repository.';
    msg.hidden = false;
  }
  $('#field').setAttribute('hidden', '');
  $('#field-caption').hidden = true;
}

async function runConsult(trigger, previous) {
  const c = state.consulting;
  if (!c) return;
  const seq = ++consultSeq;
  try {
    const resp = await apiPost('/consult', {
      line: c.text,
      line_index: c.index,
      caret_index: currentLineIndex(),
      title: titleEl.value,
      draft_text: ta.value,
      trigger: trigger || 'keyboard',
      client_ts: nowIso(),
    });
    setOnline();
    if (seq !== consultSeq) {

      postEvent('consult_discarded', { consult_id: resp.consult_id });
      return;
    }
    closeReflectBox(true);
    state.consult = resp;
    state.fieldUnavailable = false;
    state.peeked = new Set();
    renderReflectToggle();
    renderMediationCards();
    if (state.consulting) {
      state.consulting.consult_id = resp.consult_id;
      if (state.consulting.status === 'pending') state.consulting.status = 'anchored';
    }
    renderConsultStrip();
    rebuildGutter();
    const layout = renderField(resp);
    postEvent('consult_displayed', {
      consult_id: resp.consult_id,
      ...layout,
      pins_at_display: state.pins.map((p) => p.item_id),
      panel_item: state.selected ? state.selected.item_id : null,
    });
  } catch (e) {
    if (seq !== consultSeq) return;

    const attempted = state.consulting;
    state.consulting = previous || null;
    rebuildGutter();
    renderConsultStrip();
    postEvent('consult_failed', {
      line: attempted ? attempted.text : c.text,
      line_index: attempted ? attempted.index : c.index,
      trigger: trigger || 'keyboard',
      error: e.status ? String(e.status) : 'unreachable',
    });
    if (e.status === 503) {
      state.fieldUnavailable = true;
      showFieldUnavailable(e.detail || 'out of date');
      flashNote('the archive index is not available');
    } else if (e.status === 422) {
      flashNote('this line could not be consulted');
    } else {
      setOffline();
      flashNote('the archive is unreachable — the field still shows the last consult');
    }
  }
}

const tooltip = $('#tooltip');

function tooltipShow(item, res, x, y) {
  tooltip.textContent = '';
  tooltip.appendChild(el('span', null, truncate(itemText(item, res.item_id), 600)));

  tooltip.appendChild(el('span', 'tooltip-meta micro', item ? typeWord(item.item_type) : ''));
  tooltip.hidden = false;
  tooltipMove(x, y);
}

function tooltipMove(x, y) {
  const w = tooltip.offsetWidth;
  const h = tooltip.offsetHeight;
  let tx = x + 14;
  let ty = y + 12;
  if (tx + w > window.innerWidth - 8) tx = x - w - 14;
  if (ty + h > window.innerHeight - 8) ty = y - h - 12;
  tooltip.style.left = Math.max(4, tx) + 'px';
  tooltip.style.top = Math.max(4, ty) + 'px';
}

function tooltipHide() {
  tooltip.hidden = true;
}

const FIELD_W = 520;
const FIELD_C = FIELD_W / 2;
const GOLDEN = 137.508;
const R_IN = 40;
const R_OUT = 215;
const G_MIN = 8;
const EPS_SPAN = 0.01;
const N_PERSIST = 10;
const MAX_PERSIST = 10;
const LABEL_H = 13;
const PERSIST_CHARS = 34;
const PERSIST_UNITS = 210;
const HOVER_CHARS = 34;
const HOVER_UNITS = 210;
const CHAR_EST = 6.2;
const EDGE = 4;
const PAD = 2;
const GLYPH_OBS = 18;
const PEEK_MS = 300;
const FIELD_LAYOUT = 'field/v4';
const LABEL_GAPS = [10, 20, 30, 40];

const FIELD_CONSTANTS = {
  FIELD_W, GOLDEN, R_IN, R_OUT, G_MIN, EPS_SPAN, N_PERSIST, MAX_PERSIST,
  PERSIST_CHARS, HOVER_CHARS, PEEK_MS, LABEL_GAPS, field_layout: FIELD_LAYOUT,
  label_policy: 'all10',
  tooltip_cosine: false,
};

function radiusPolicy(results) {
  const k = results.length;
  if (k === 0) return { radii: [], policy: 'none' };
  if (k === 1) return { radii: [R_IN], policy: 'single' };
  const d = results.map((r) => 1 - r.score);
  const span = d[k - 1] - d[0];
  if (span < EPS_SPAN) {
    return {
      radii: d.map((_, i) => R_IN + (i * (R_OUT - R_IN)) / (k - 1)),
      policy: 'rank',
    };
  }
  const radii = d.map((di) => R_IN + ((di - d[0]) / span) * (R_OUT - R_IN));
  for (let i = 1; i < k; i++) radii[i] = Math.max(radii[i], radii[i - 1] + G_MIN);
  if (radii[k - 1] > R_OUT) {
    const f = (R_OUT - R_IN) / (radii[k - 1] - R_IN);
    for (let i = 0; i < k; i++) radii[i] = R_IN + (radii[i] - R_IN) * f;
  }
  return { radii, policy: 'minmax-gap' + G_MIN };
}

function typeGlyph(type, x, y) {
  let g;
  if (type === 'prose_excerpt') {
    g = svg('rect', {
      x: x - 5, y: y - 5, width: 10, height: 10,
      transform: 'rotate(45 ' + x + ' ' + y + ')',
    });
  } else if (type === 'note') {
    g = svg('rect', { x: x - 4.5, y: y - 4.5, width: 9, height: 9, rx: 2.5 });
  } else if (type === 'fragment') {
    g = svg('circle', { cx: x, cy: y, r: 4.5 });
  } else {
    g = svg('circle', { cx: x, cy: y, r: 5 });
    type = 'poetry';
  }
  g.setAttribute('class', 'glyph ' + type);
  return g;
}

function rectsOverlap(a, b) {
  return !(
    a.x + a.w + PAD < b.x || b.x + b.w + PAD < a.x ||
    a.y + a.h + PAD < b.y || b.y + b.h + PAD < a.y
  );
}

function inBounds(r) {
  return r.x >= EDGE && r.y >= EDGE &&
    r.x + r.w <= FIELD_W - EDGE && r.y + r.h <= FIELD_W - EDGE;
}

function annotRect(seat, width) {
  const x = seat.anchor === 'middle' ? seat.x - width / 2
    : seat.anchor === 'end' ? seat.x - width : seat.x;
  return { x, y: seat.y - 9, w: width, h: LABEL_H };
}

function placeAnnot(textEl, width, seats, glyphRects) {
  let chosen = seats[0];
  for (const seat of seats) {
    const r = annotRect(seat, width);
    if (inBounds(r) && !glyphRects.some((g) => rectsOverlap(r, g))) {
      chosen = seat;
      break;
    }
  }
  textEl.setAttribute('x', chosen.x);
  textEl.setAttribute('y', chosen.y);
  textEl.setAttribute('text-anchor', chosen.anchor);
  return annotRect(chosen, width);
}

function measureLabels(field, specs) {
  const g = svg('g', { class: 'measure', visibility: 'hidden' });
  const nodes = specs.map((s) => {
    const t = svg('text', { class: 'node-label', x: 0, y: 0 });
    t.textContent = s.text;
    g.appendChild(t);
    return t;
  });
  field.appendChild(g);
  let measured = true;
  const out = specs.map((s, i) => {
    const t = nodes[i];
    let text = s.text;
    let w = 0;
    try { w = t.getComputedTextLength(); } catch (e) { w = 0; }
    if (!(w > 0)) {
      measured = false;
      w = text.length * CHAR_EST;
      if (w > s.maxUnits) {
        const n = Math.max(1, Math.floor(s.maxUnits / CHAR_EST) - 1);
        text = text.slice(0, n).trimEnd() + '…';
        w = text.length * CHAR_EST;
      }
      return { text, width: w };
    }
    if (w > s.maxUnits) {
      const full = text.endsWith('…') ? text.slice(0, -1) : text;
      t.textContent = full + '…';
      const ellW = t.getSubStringLength(full.length, 1);
      let lo = 1;
      let hi = full.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (t.getSubStringLength(0, mid) + ellW <= s.maxUnits) lo = mid;
        else hi = mid - 1;
      }
      const sp = full.lastIndexOf(' ', lo);
      if (sp > lo / 2) lo = sp;
      text = full.slice(0, lo).replace(/[\s,;:.—-]+$/, '') + '…';
      t.textContent = text;
      w = t.getComputedTextLength();
    }
    return { text, width: w };
  });
  g.remove();
  return { labels: out, measured };
}

const DIRS = [
  { name: 'E', dx: 1, dy: 0 },
  { name: 'W', dx: -1, dy: 0 },
  { name: 'N', dx: 0, dy: -1 },
  { name: 'S', dx: 0, dy: 1 },
  { name: 'NE', dx: 0.8, dy: -0.8 },
  { name: 'NW', dx: -0.8, dy: -0.8 },
  { name: 'SE', dx: 0.8, dy: 0.8 },
  { name: 'SW', dx: -0.8, dy: 0.8 },
];

function candidateRect(gx, gy, w, dir, gap) {
  const ax = gx + dir.dx * gap;
  const ay = gy + dir.dy * gap;
  const anchor = dir.dx > 0.1 ? 'start' : dir.dx < -0.1 ? 'end' : 'middle';
  const x = anchor === 'start' ? ax : anchor === 'end' ? ax - w : ax - w / 2;
  let baseline;
  let y;
  if (dir.dy < -0.1) { baseline = ay - 1; y = baseline - 10; }
  else if (dir.dy > 0.1) { baseline = ay + 10; y = ay; }
  else { baseline = ay + 4; y = ay - 6.5; }
  return { x, y, w, h: LABEL_H, tx: ax, ty: baseline, anchor, dir, gap };
}

function orderedDirs(gx, gy) {
  let ox = gx - FIELD_C;
  let oy = gy - FIELD_C;
  const len = Math.hypot(ox, oy);
  if (len < 1e-6) { ox = 0; oy = -1; } else { ox /= len; oy /= len; }
  return DIRS.map((d) => {
    const dl = Math.hypot(d.dx, d.dy);
    const score = (ox * d.dx + oy * d.dy) / dl + (d.name === 'E' || d.name === 'W' ? 0.15 : 0);
    return { d, score };
  }).sort((a, b) => b.score - a.score).map((s) => s.d);
}

function findSlot(gx, gy, w, obstacles) {
  const dirs = orderedDirs(gx, gy);
  let best = null;
  let bestHits = Infinity;
  for (const gap of LABEL_GAPS) {
    for (const d of dirs) {
      const c = candidateRect(gx, gy, w, d, gap);
      if (!inBounds(c)) continue;
      const hits = obstacles.filter((o) => rectsOverlap(o, c)).length;
      if (hits === 0) return { rect: c, free: true };
      if (hits < bestHits) { best = c; bestHits = hits; }
    }
  }
  if (!best) {

    const c = candidateRect(gx, gy, w, DIRS[0], 10);
    c.x = Math.max(EDGE, Math.min(c.x, FIELD_W - EDGE - w));
    c.tx = c.x;
    best = c;
  }
  return { rect: best, free: false };
}

function labelElement(rect, text, hoverOnly) {
  const t = svg('text', { x: rect.tx, y: rect.ty, 'text-anchor': rect.anchor });
  t.setAttribute('class', 'node-label' + (hoverOnly ? ' is-hover' : ''));
  t.textContent = text;
  return t;
}

function leaderFor(gx, gy, rect) {
  const dl = Math.hypot(rect.dir.dx, rect.dir.dy);
  const nx = rect.dir.dx / dl;
  const ny = rect.dir.dy / dl;
  return svg('line', {
    x1: gx + nx * 7, y1: gy + ny * 7,
    x2: gx + nx * (rect.gap - 2), y2: gy + ny * (rect.gap - 2),
    class: 'leader',
  });
}

function pinControl(rect, res) {
  let cx = rect.anchor === 'end' ? rect.x - 9 : rect.x + rect.w + 9;
  if (cx > FIELD_W - 8) cx = rect.x - 9;
  if (cx < 8) cx = rect.x + rect.w + 9;
  const cy = rect.y + rect.h / 2;
  const pinned = isPinned(res.item_id);
  const pinG = svg('g', { class: 'pin-ctl' });
  pinG.appendChild(svg('circle', { cx, cy, r: 7 }));
  const pinT = svg('text', { x: cx, y: cy + 3.5, 'text-anchor': 'middle' });
  pinT.textContent = pinned ? '−' : '+';
  pinG.appendChild(pinT);
  const pinTitle = svg('title');
  pinTitle.textContent = pinned ? 'unpin' : 'pin';
  pinG.appendChild(pinTitle);
  pinG.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePin(res, 'field');
  });
  return pinG;
}

function sparklePath(cx, cy, r) {
  const s = r * 0.32;
  return 'M' + cx + ' ' + (cy - r) +
    ' C' + (cx + s * 0.25) + ' ' + (cy - s) + ' ' + (cx + s) + ' ' + (cy - s * 0.25) + ' ' + (cx + r) + ' ' + cy +
    ' C' + (cx + s) + ' ' + (cy + s * 0.25) + ' ' + (cx + s * 0.25) + ' ' + (cy + s) + ' ' + cx + ' ' + (cy + r) +
    ' C' + (cx - s * 0.25) + ' ' + (cy + s) + ' ' + (cx - s) + ' ' + (cy + s * 0.25) + ' ' + (cx - r) + ' ' + cy +
    ' C' + (cx - s) + ' ' + (cy - s * 0.25) + ' ' + (cx - s * 0.25) + ' ' + (cy - s) + ' ' + cx + ' ' + (cy - r) + ' Z';
}

function labelText(item, fallback, chars) {
  const full = itemText(item, fallback);
  const first = firstLine(full);
  let s = softTruncate(first, chars);
  if (full.includes('\n') && !s.endsWith('…')) s += ' …';
  return s;
}

function renderField(resp) {
  tooltipHide();
  const field = $('#field');
  field.textContent = '';
  const emptyMsg = document.querySelector('#view-field .placeholder');
  if (emptyMsg) emptyMsg.hidden = true;
  field.removeAttribute('hidden');
  fitField();
  $('#field-caption').hidden = false;

  const results = resp.results || [];
  const { radii, policy } = radiusPolicy(results);

  for (const r of [R_IN, R_OUT]) {
    field.appendChild(svg('circle', { cx: FIELD_C, cy: FIELD_C, r, class: 'ring' }));
  }

  const center = svg('path', { d: sparklePath(FIELD_C, FIELD_C, 9), class: 'center-mark' });
  const ct = svg('title');
  ct.textContent = 'your line';
  center.appendChild(ct);
  field.appendChild(center);
  const cl = svg('text', { class: 'center-label' });
  cl.textContent = 'your line';
  field.appendChild(cl);

  const nodes = results.map((raw, i) => {
    const item = state.itemsById.get(raw.item_id);
    const angleDeg = -90 + GOLDEN * i;
    const aRad = (angleDeg * Math.PI) / 180;

    const res = { ...raw, consult_id: resp.consult_id, query_line: resp.line,
      line_index: resp.line_index };
    return {
      res, i, item,
      x: FIELD_C + radii[i] * Math.cos(aRad),
      y: FIELD_C + radii[i] * Math.sin(aRad),
      full: itemText(item, res.item_id),
    };
  });

  const persistent = new Set(nodes.map((n) => n.res.item_id));

  const specs = [];
  for (const n of nodes) {
    const p = persistent.has(n.res.item_id);
    specs.push({
      text: labelText(n.item, n.res.item_id, p ? PERSIST_CHARS : HOVER_CHARS),
      maxUnits: p ? PERSIST_UNITS : HOVER_UNITS,
    });
  }
  const measured = measureLabels(field, specs.concat([{ text: 'your line', maxUnits: 999 }]));
  const labels = measured.labels.slice(0, nodes.length);
  const ylW = measured.labels[nodes.length].width;
  const glyphRects = nodes.map((n) => ({
    x: n.x - GLYPH_OBS / 2, y: n.y - GLYPH_OBS / 2, w: GLYPH_OBS, h: GLYPH_OBS,
  }));

  const ylRect = placeAnnot(cl, ylW, [
    { x: FIELD_C, y: FIELD_C + 22, anchor: 'middle' },
    { x: FIELD_C, y: FIELD_C - 14, anchor: 'middle' },
  ], glyphRects);

  const obstacles = [{ x: FIELD_C - 11, y: FIELD_C - 11, w: 22, h: 22 }, ylRect];

  const placement = new Map();
  const labelState = new Map();

  const placed = [];
  for (const n of nodes) {
    const others = glyphRects.filter((_, j) => j !== n.i);
    const slot = findSlot(n.x, n.y, labels[n.i].width, obstacles.concat(others, placed));
    placed.push(slot.rect);
    placement.set(n.res.item_id, { rect: slot.rect, hoverOnly: false });
    labelState.set(n.res.item_id, slot.free ? 'visible' : 'overlapped');
  }

  for (const n of nodes) {
    const { res, i, item, x, y } = n;
    const p = placement.get(res.item_id);
    const g = svg('g', { class: 'node' });
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', firstLine(n.full) + ' · ' + (item ? typeWord(item.item_type) : 'item'));

    g.appendChild(svg('circle', { cx: x, cy: y, r: 11, class: 'hit' }));
    if (p.rect.gap >= 20) g.appendChild(leaderFor(x, y, p.rect));
    if (isPinned(res.item_id)) {
      g.appendChild(svg('circle', { cx: x, cy: y, r: 8.5, class: 'pin-ring' }));
    }
    g.appendChild(typeGlyph(item ? item.item_type : 'poetry', x, y));
    g.appendChild(labelElement(p.rect, labels[i].text, p.hoverOnly));
    g.appendChild(pinControl(p.rect, res));

    let peekTimer = null;
    const peekStart = (via) => {
      if (!state.consult) return;
      const key = state.consult.consult_id + '|' + res.item_id;
      if (state.peeked.has(key)) return;
      peekTimer = setTimeout(() => {
        peekTimer = null;
        if (state.peeked.has(key)) return;
        state.peeked.add(key);
        postEvent('peek', {
          consult_id: state.consult.consult_id, item_id: res.item_id,
          rank: res.rank, via, label_state: labelState.get(res.item_id),
        });
      }, PEEK_MS);
    };
    const peekStop = () => { if (peekTimer) { clearTimeout(peekTimer); peekTimer = null; } };
    g.addEventListener('mouseenter', (e) => {
      if (field.lastElementChild !== g) field.appendChild(g);
      tooltipShow(item, res, e.clientX, e.clientY);
      peekStart('hover');
    });
    g.addEventListener('mousemove', (e) => tooltipMove(e.clientX, e.clientY));
    g.addEventListener('mouseleave', () => { tooltipHide(); peekStop(); });
    g.addEventListener('focus', () => {
      const b = g.getBoundingClientRect();
      tooltipShow(item, res, b.left + b.width / 2, b.top + b.height / 2);
      peekStart('focus');
    });
    g.addEventListener('blur', () => { tooltipHide(); peekStop(); });
    g.addEventListener('click', () => openItem(res.item_id, res, 'field'));
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') openItem(res.item_id, res, 'keyboard');
    });
    field.appendChild(g);
  }

  return {
    field_layout: FIELD_LAYOUT,
    radius_policy: policy,
    label_policy: 'all10',
    nodes: nodes.map((n, i) => ({
      item_id: n.res.item_id, rank: n.res.rank,
      label_state: labelState.get(n.res.item_id), label_text: labels[i].text,
    })),
    label_measured: measured.measured,
    field_css_px: Math.round(field.getBoundingClientRect().width),
  };
}

function fitField() {
  const box = $('#field-scroll');
  const field = $('#field');
  const side = Math.max(120, Math.min(box.clientWidth, box.clientHeight)) * state.zoom;
  field.style.width = side + 'px';
  field.style.height = side + 'px';
}

if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => { if (!$('#field').hasAttribute('hidden')) fitField(); })
    .observe($('#field-scroll'));
}

function rerenderField(reason) {
  if (!state.consult || state.fieldUnavailable) return;
  const layout = renderField(state.consult);
  postEvent('field_relayout', {
    consult_id: state.consult.consult_id, reason, nodes: layout.nodes,
  });
}

if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => { if (state.consult) rerenderField('fonts'); });
}

const ZOOMS = [1, 1.5, 2];

function applyZoom() {
  $('#zoom-out').disabled = state.zoom <= ZOOMS[0];
  $('#zoom-in').disabled = state.zoom >= ZOOMS[ZOOMS.length - 1];
  fitField();
  postEvent('field_view', { zoom: state.zoom, consult_id: consultId() });
}

$('#zoom-in').addEventListener('click', () => {
  const i = ZOOMS.indexOf(state.zoom);
  if (i < ZOOMS.length - 1) { state.zoom = ZOOMS[i + 1]; applyZoom(); }
});
$('#zoom-out').addEventListener('click', () => {
  const i = ZOOMS.indexOf(state.zoom);
  if (i > 0) { state.zoom = ZOOMS[i - 1]; applyZoom(); }
});

function currentQueryLine() {
  return state.consulting ? state.consulting.consultedText : (state.consult ? state.consult.line : '');
}

async function togglePin(res, origin) {
  if (readOnlyGuard()) return;
  try {
    let out;
    const wasPinned = isPinned(res.item_id);
    if (wasPinned) {
      out = await apiPost('/unpin', { item_id: res.item_id, origin, client_ts: nowIso() });
    } else {

      out = await apiPost('/pin', {
        item_id: res.item_id,
        consult_id: res.consult_id !== undefined ? (res.consult_id || null) : consultId(),
        rank: res.rank == null ? null : res.rank,
        rank_raw: res.rank_raw == null ? null : res.rank_raw,
        score: res.score == null ? null : res.score,
        query_line: res.query_line !== undefined ? (res.query_line || '') : currentQueryLine(),
        line_index: res.line_index !== undefined
          ? (res.line_index == null ? null : res.line_index)
          : (state.consulting ? state.consulting.index : null),
        origin,
        client_ts: nowIso(),
      });
    }
    setOnline();
    state.pins = out.pins || [];
    renderPins(!wasPinned ? res.item_id : null);
    rerenderField(wasPinned ? 'unpin' : 'pin');
    refreshItemPin();
  } catch (e) {
    setOffline();
    flashNote(isPinned(res.item_id) ? 'could not unpin — try again' : 'could not pin — try again');
  }
}

function renderPins(scrollTo) {
  const list = $('#pin-list');
  const label = $('#pin-tray-label');
  list.textContent = '';
  $('#pin-empty').hidden = state.pins.length > 0;
  label.textContent = state.pins.length
    ? 'pinned material (' + state.pins.length + ')'
    : 'pinned material';
  let target = null;
  for (const p of state.pins) {
    const item = state.itemsById.get(p.item_id);
    const card = el('div', 'pin-card');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    const head = el('div', 'pin-card-head');
    const key = el('span', 'key key-' + (item ? item.item_type : 'poetry'));
    key.setAttribute('aria-hidden', 'true');
    head.appendChild(key);
    head.appendChild(el('span', null, item ? typeWord(item.item_type) : 'item'));
    const un = el('button', 'unpin', '×');
    un.type = 'button';
    un.title = 'unpin';
    un.setAttribute('aria-label', 'Unpin ' + truncate(firstLine(itemText(item, p.item_id)), 30));
    un.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePin({ item_id: p.item_id }, 'tray');
    });
    head.appendChild(un);
    card.appendChild(head);
    card.appendChild(el('div', 'pin-text', itemText(item, p.item_id)));
    if (p.query_line) {
      const meta = el('div', 'pin-meta micro', 'for “' + p.query_line + '”');
      meta.title = 'the line this was surfaced for';
      card.appendChild(meta);
    }
    const open = () => openItem(p.item_id, {
      item_id: p.item_id, consult_id: p.consult_id, rank: p.rank, rank_raw: p.rank_raw,
      score: p.score, query_line: p.query_line, line_index: p.line_index,
    }, 'tray');
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    list.appendChild(card);
    if (scrollTo && p.item_id === scrollTo) target = card;
  }
  if (target && typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ inline: 'end', block: 'nearest' });
  }
}

$('#pin-tray-toggle').addEventListener('click', () => {
  const tray = $('#pin-tray');
  const collapsed = tray.classList.toggle('collapsed');
  const btn = $('#pin-tray-toggle');
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.setAttribute('aria-label', (collapsed ? 'Expand' : 'Collapse') + ' pinned material');
  postEvent('pin_tray_toggle', { collapsed });
});

const panelQuery = window.matchMedia ? window.matchMedia('(min-width: 1100px)') : null;

function updatePanelMode() {
  state.panelMode = !panelQuery || panelQuery.matches ? 'column' : 'slide';
  if (state.panelMode === 'column') {
    $('#item-pane').classList.remove('open');
    loadCols();
  } else {
    mainEl.style.gridTemplateColumns = '';
  }
}
if (panelQuery) {
  (panelQuery.addEventListener ? panelQuery.addEventListener('change', updatePanelMode)
    : panelQuery.addListener(updatePanelMode));
}

let itemLastFocus = null;

function itemCue(item) {
  const parts = [];
  const shown = [];
  const type = item.item_type;
  if (type === 'fragment') parts.push('unused fragment');
  else parts.push(typeWord(type));
  shown.push('item_type');
  const creator = (item.creator || '').trim();
  const external = item.authorship === 'external';
  if (creator && creator !== 'self') { parts.push(creator); shown.push('creator'); }
  else if (external && (type === 'poetry' || type === 'prose_excerpt')) {
    parts.push('saved excerpt');
    shown.push('authorship');
  }
  const title = (item.source_title || '').trim();
  const text = item.display_text || '';
  if (title && title !== text && title !== firstLine(text)) {
    parts.push((item.source_kind === 'own_poem' ? 'from “' : '“') + title + '”');
    shown.push('source_title');
  }
  const date = (item.source_date || '').trim();
  if (date) { parts.push(date); shown.push('source_date'); }
  return { text: parts.join(' · '), shown };
}

function openItem(itemId, res, origin) {
  const item = state.itemsById.get(itemId);
  if (!item) {
    flashNote('this item is not in the current archive');
    return;
  }
  const pane = $('#item-pane');
  const fromTray = origin === 'tray';

  const provenance = res.consult_id !== undefined ? (res.consult_id || null) : consultId();
  const queryLine = res.query_line !== undefined ? (res.query_line || '') : currentQueryLine();
  state.selected = {
    item_id: itemId,
    consult_id: provenance,
    field_consult_id: consultId(),
    pin_consult_id: fromTray ? provenance : null,
    rank: res.rank == null ? null : res.rank,
    rank_raw: res.rank_raw == null ? null : res.rank_raw,
    score: res.score == null ? null : res.score,
    origin,
    query_line: queryLine,
    line_index: res.line_index !== undefined
      ? (res.line_index == null ? null : res.line_index)
      : (state.consulting ? state.consulting.index : null),
  };

  $('#item-empty').hidden = true;
  $('#item-content').hidden = false;
  const pill = $('#item-type');
  pill.className = 'type-pill ' + item.item_type;
  pill.firstElementChild.className = 'key key-' + item.item_type;
  $('#item-type-text').textContent = typeWord(item.item_type);
  $('#item-body').textContent = item.display_text;
  const cue = itemCue(item);
  $('#item-cue').textContent = cue.text;
  renderItemSource(item);
  renderRecurrence(itemId);
  renderConnectPicks();
  renderMediationCards();
  if (origin === 'source') {
    const via = res.via_item ? state.itemsById.get(res.via_item) : null;
    $('#item-for').textContent = via
      ? 'reached through the source of “' + truncate(firstLine(via.display_text), 60) + '”'
      : 'reached through its source';
    $('#item-for').hidden = false;
  } else {
    $('#item-for').textContent = queryLine ? 'surfaced for “' + queryLine + '”' : '';
    $('#item-for').hidden = !queryLine;
  }
  refreshItemPin();

  if (state.panelMode === 'slide') {
    if (!pane.classList.contains('open')) itemLastFocus = document.activeElement;
    pane.classList.add('open');
    if (origin === 'keyboard') $('#item-close').focus();
  }

  postEvent('open_item', {
    item_id: itemId,
    consult_id: state.selected.consult_id,
    field_consult_id: state.selected.field_consult_id,
    pin_consult_id: state.selected.pin_consult_id,
    via_item: origin === 'source' ? (res.via_item || null) : undefined,
    rank: state.selected.rank,
    rank_raw: state.selected.rank_raw,
    score: state.selected.score,
    origin,
    cue_shown: cue.shown,
    source_kind: item.source_kind,
  });
}

function sourceToggleLabel(s) {
  if (s.kind === 'siblings') {
    const n = s.sibs.length;
    return s.expanded ? 'hide the other units'
      : 'show the other ' + (n === 1 ? 'unit' : n + ' units') + ' from this source';
  }
  if (s.expanded) return 'hide the whole poem';
  const item = state.itemsById.get(s.item_id);
  const title = (s.src.title || '').trim();
  return title && item && title !== item.display_text
    ? 'show the whole poem “' + title + '”' : 'show the whole poem';
}

function siblingsOf(item) {
  if (!item.source_id || item.source_id === item.item_id) return [];
  const out = [];
  for (const it of state.itemsById.values()) {
    if (it.source_id === item.source_id && it.item_id !== item.item_id) out.push(it);
  }
  return out;
}

function renderItemSource(item) {
  const box = $('#item-source');
  const btn = $('#item-source-toggle');
  const txt = $('#item-source-text');
  txt.textContent = '';
  txt.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
  const src = item.source_kind === 'own_poem' ? state.sources[item.source_id] : null;
  if (src && src.text) {
    state.sourceShown = { kind: 'poem', item_id: item.item_id, source_id: item.source_id, src,
      expanded: false, posted: false };
  } else {
    const sibs = siblingsOf(item);
    if (!sibs.length) {
      box.hidden = true;
      state.sourceShown = null;
      return;
    }
    state.sourceShown = { kind: 'siblings', item_id: item.item_id, source_id: item.source_id,
      sibs, expanded: false, posted: false };
  }
  btn.textContent = sourceToggleLabel(state.sourceShown);
  box.hidden = false;
}

function renderSiblingList(s, txt) {
  const parent = state.itemsById.get(s.item_id);
  for (const sib of s.sibs) {
    const row = el('div', 'source-sib');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const key = el('span', 'key key-' + sib.item_type);
    key.setAttribute('aria-hidden', 'true');
    row.appendChild(key);
    row.appendChild(el('span', 'sib-text', sib.display_text));
    const open = () => openItem(sib.item_id, {
      item_id: sib.item_id,
      consult_id: state.selected ? state.selected.consult_id : consultId(),
      query_line: '',
      line_index: null,
      via_item: parent ? parent.item_id : null,
    }, 'source');
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    txt.appendChild(row);
  }
}

function toggleItemSource() {
  const s = state.sourceShown;
  if (!s) return;
  const btn = $('#item-source-toggle');
  const txt = $('#item-source-text');
  s.expanded = !s.expanded;
  btn.setAttribute('aria-expanded', String(s.expanded));
  btn.textContent = sourceToggleLabel(s);
  if (!s.expanded) {
    txt.hidden = true;
    return;
  }
  txt.textContent = '';
  if (s.kind === 'siblings') {
    renderSiblingList(s, txt);
  } else {
    const item = state.itemsById.get(s.item_id);
    const title = (s.src.title || '').trim();
    if (title) txt.appendChild(el('div', 'source-title', title + (s.src.date ? ' · ' + s.src.date : '')));
    for (const line of s.src.text.split('\n')) {
      const own = item && line === item.display_text;
      txt.appendChild(el('div', 'source-line' + (own ? ' source-line-own' : ''), line || ' '));
    }
  }
  txt.hidden = false;
  if (!s.posted) {
    s.posted = true;
    postEvent('source_expanded', {
      item_id: s.item_id,
      source_id: s.source_id,
      consult_id: state.selected ? state.selected.consult_id : consultId(),
      kind: s.kind,
      lines: s.kind === 'poem' ? s.src.text.split('\n').length : null,
      count: s.kind === 'siblings' ? s.sibs.length : null,
    });
  }
}

$('#item-source-toggle').addEventListener('click', toggleItemSource);

async function renderRecurrence(itemId) {
  const line = $('#item-recur');
  line.hidden = true;
  line.textContent = '';
  try {
    const r = await apiGet('/recurrence/' + encodeURIComponent(itemId));
    if (!state.selected || state.selected.item_id !== itemId) return;
    if (r.sessions > 0) {
      line.textContent = 'appeared in ' + r.sessions + ' earlier session' + (r.sessions === 1 ? '' : 's');
      line.hidden = false;
    }
    state.selected.recurrence_sessions = r.sessions;
  } catch (e) {                            }
}

const CONNECT_MAX_ITEMS = 3;

function isPicked(itemId) {
  return state.connectPicks.some((p) => p.item_id === itemId);
}

function logConnectSelect(action, pick) {
  postEvent('connect_select', {
    action, item_id: pick.item_id, consult_id: consultId(), item_consult_id: pick.consult_id || null,
    origin: pick.origin || null, selected: state.connectPicks.map((p) => p.item_id),
  });
}

function toggleConnectPick() {
  const s = state.selected;
  if (!s || readOnlyGuard()) return;
  if (isPicked(s.item_id)) { removeConnectPick(s.item_id); return; }
  if (state.connectPicks.length >= CONNECT_MAX_ITEMS) {
    flashNote('three at most — remove one first');
    return;
  }
  const pick = { item_id: s.item_id, consult_id: s.consult_id, rank: s.rank, origin: s.origin };
  state.connectPicks.push(pick);
  logConnectSelect('add', pick);
  renderConnectPicks();
}

function removeConnectPick(itemId) {
  const pick = state.connectPicks.find((p) => p.item_id === itemId);
  if (!pick) return;
  state.connectPicks = state.connectPicks.filter((p) => p !== pick);
  logConnectSelect('remove', pick);
  renderConnectPicks();
}

function pickLabel(itemId) {
  const item = state.itemsById.get(itemId);
  return item ? labelText(item, itemId, HOVER_CHARS) : itemId;
}

function renderConnectPicks() {
  const box = $('#connect-picks');
  box.textContent = '';
  for (const p of state.connectPicks) {
    const item = state.itemsById.get(p.item_id);
    const chip = el('div', 'pick-chip' + (state.selected && state.selected.item_id === p.item_id ? ' current' : ''));
    chip.appendChild(el('span', 'key key-' + (item ? item.item_type : 'note')));
    const label = pickLabel(p.item_id);
    const t = el('span', 'pick-text', label);
    t.title = item ? firstLine(item.display_text) : p.item_id;
    chip.appendChild(t);
    const x = el('button', 'unpick', '×');
    x.type = 'button';
    x.title = 'remove from Connect';
    x.setAttribute('aria-label', 'Remove from Connect: ' + label);
    x.addEventListener('click', () => removeConnectPick(p.item_id));
    chip.appendChild(x);
    box.appendChild(chip);
  }
  const n = state.connectPicks.length;
  $('#connect-hint').textContent = n
    ? n + ' of ' + CONNECT_MAX_ITEMS + ' chosen for Connect'
    : 'nothing chosen yet · open an item and add it';
  renderMediationButtons();
}

$('#connect-add').addEventListener('click', toggleConnectPick);

function cardsForSelection() {
  const s = state.selected;
  if (!s) return [];
  const cid = consultId();
  return state.mediations.filter((m) => !m.dismissed && (
    m.action === 'connect'
      ? m.consult_id === cid
      : (m.item_id === s.item_id && m.consult_id === s.consult_id)));
}

function renderMediationButtons() {
  const s = state.selected;
  const live = !!(state.session && !state.session.ended_utc
    && !state.readOnlyConflict && !state.noSession && !state.mediating);
  const add = $('#connect-add');
  const picked = !!(s && isPicked(s.item_id));
  add.disabled = !(s && live);
  add.textContent = picked ? '− Remove from Connect' : '+ Add to Connect';
  add.classList.toggle('picked', picked);
  add.setAttribute('aria-pressed', picked ? 'true' : 'false');
  add.title = picked ? 'take this item out of the Connect selection'
    : 'choose this item for Connect (up to three)';
  const n = state.connectPicks.length;
  $('#mediate-connect').disabled = !(state.mediationAvailable && live && consultId() && n >= 1 && n <= CONNECT_MAX_ITEMS);
  $('#mediate-reframe').disabled = !(state.mediationAvailable && s && s.consult_id && live);
  $('#mediation').hidden = !s && state.mediationAvailable;
  $('#mediation-unavailable').hidden = state.mediationAvailable;
}

//Render returned text without treating it as HTML.
function renderMediationText(box, text) {
  let para = null;
  for (const ln of String(text || '').split('\n')) {
    const bare = ln.trim();
    if (!bare) { para = null; continue; }
    if (!para) { para = el('div', 'med-line'); box.appendChild(para); }
    else para.appendChild(document.createTextNode('\n'));
    para.appendChild(document.createTextNode(ln));
  }
}

function renderMediationCards() {
  const box = $('#mediation-cards');
  box.textContent = '';
  for (const m of cardsForSelection()) {
    const kind = m.action || (m.role === 'reframer' ? 'reframe' : 'connect');
    const ids = m.item_ids || (m.item_id ? [m.item_id] : []);
    const card = el('div', 'med-card ' + kind + (m.status === 'failed' ? ' failed' : '') + (m.status === 'requested' ? ' pending' : ''));
    const head = el('div', 'med-card-head');
    head.appendChild(el('span', 'card-title', kind));

    head.appendChild(el('span', 'micro', m.status === 'completed' ? ''
      : m.status === 'failed' ? 'no reading arrived' : 'working…'));
    const x = el('button', 'dismiss', '×');
    x.type = 'button';
    x.title = 'put this card away (it stays in the record)';
    x.setAttribute('aria-label', 'Dismiss ' + kind + ' card');
    x.addEventListener('click', () => { m.dismissed = true; renderMediationCards(); });
    head.appendChild(x);
    card.appendChild(head);
    if (kind === 'connect') card.appendChild(el('div', 'med-items micro', ids.map(pickLabel).join(' + ')));
    if (m.status === 'completed') {
      const body = el('div', 'med-text');
      renderMediationText(body, m.output);
      card.appendChild(body);
    } else {
      card.appendChild(el('div', 'med-text',
        m.status === 'failed' ? 'failed: ' + (m.error || 'unknown error') : 'working…'));
    }
    box.appendChild(card);
  }
  renderMediationButtons();
}

async function requestMediation(role) {
  const s = state.selected;
  if (!s || readOnlyGuard() || state.mediating || !state.mediationAvailable) return;
  const connect = role === 'connect';
  const cid = connect ? consultId() : s.consult_id;
  const ids = connect ? state.connectPicks.map((p) => p.item_id) : [s.item_id];
  if (!cid || ids.length < 1 || ids.length > CONNECT_MAX_ITEMS) return;
  const pending = { mediation_id: 'pending', role: connect ? 'connector' : 'reframer', action: role,
    consult_id: cid, item_id: connect ? null : s.item_id, item_ids: ids, status: 'requested' };
  state.mediations.push(pending);
  state.mediating = role;
  renderMediationCards();
  try {
    await flushDraftSave();
    const body = connect
      ? { role, consult_id: cid, item_ids: ids,
          line: state.consult.line || '', line_index: state.consult.line_index == null ? null : state.consult.line_index }
      : { role, consult_id: cid, item_id: s.item_id,
          line: s.query_line || '', line_index: s.line_index == null ? null : s.line_index };
    const out = await apiPost('/mediate', {
      ...body, title: titleEl.value, draft_text: ta.value, client_ts: nowIso(),
    });
    setOnline();
    state.mediations = state.mediations.filter((m) => m !== pending);
    state.mediations.push(out.mediation);
  } catch (e) {
    state.mediations = state.mediations.filter((m) => m !== pending);
    state.mediations.push({ ...pending, status: 'failed', error: e.status ? String(e.status) + ' ' + (e.detail || '') : 'unreachable' });
    setOffline();
  } finally {
    state.mediating = null;
    renderMediationCards();
  }
}

$('#mediate-connect').addEventListener('click', () => requestMediation('connect'));
$('#mediate-reframe').addEventListener('click', () => requestMediation('reframe'));

function refreshItemPin() {
  const btn = $('#item-pin');
  if (!state.selected) return;
  const pinned = isPinned(state.selected.item_id);
  btn.classList.toggle('pinned', pinned);
  $('#item-pin-text').textContent = pinned ? 'Unpin' : 'Pin';
}

$('#item-pin').addEventListener('click', () => {
  const s = state.selected;
  if (!s) return;
  togglePin({
    item_id: s.item_id, consult_id: s.consult_id, rank: s.rank,
    rank_raw: s.rank_raw, score: s.score, query_line: s.query_line, line_index: s.line_index,
  }, 'panel');
});

function closeItem() {
  const pane = $('#item-pane');
  if (state.panelMode === 'slide') {
    pane.classList.remove('open');
    if (itemLastFocus && typeof itemLastFocus.focus === 'function') itemLastFocus.focus();
    itemLastFocus = null;
  } else {
    state.selected = null;
    $('#item-content').hidden = true;
    $('#item-empty').hidden = false;
  }
  renderMediationButtons();
}

$('#item-close').addEventListener('click', closeItem);

const notePop = $('#note-pop');
const noteText = $('#note-text');

function positionNotePopover() {
  const np = state.notePop;
  if (!np || np.mode !== 'line') return;
  const top = PAD_TOP + (np.index + 1) * LH - ta.scrollTop + 2;
  notePop.style.top = Math.max(0, Math.min(top, ta.clientHeight - notePop.offsetHeight - 4)) + 'px';
}

function openNotePopover(index) {
  if (readOnlyGuard()) return;
  const ls = lines();
  const line = ls[index];
  if (line === undefined || !line.trim()) {
    flashNote('a blank line cannot carry a note');
    return;
  }
  if (state.annotated) toggleAnnotated(false);
  if (state.notePop && state.notePop.mode === 'detached') closeDetached();
  if (state.notePop && state.notePop.mode === 'line') {
    if (state.notePop.index === index) { noteText.focus(); return; }
    stashNoteDraft();
  }
  const existing = noteAt(index);
  state.notePop = {
    index, noteId: existing ? existing.id : null, mode: 'line',
    lineText: line, anchorText: existing ? (existing.anchor_text || line) : line,
  };
  $('#note-pop-line').textContent = 'line ' + (index + 1) + ' · ' + line;
  const draft = state.noteDrafts.get(index);
  noteText.value = draft !== undefined ? draft : (existing ? existing.text : '');
  noteText.hidden = false;
  $('#note-pop-actions').hidden = false;
  $('#note-pop-detached').hidden = true;
  $('#note-delete').hidden = !existing;
  notePop.hidden = false;
  positionNotePopover();
  noteText.focus();
}

function stashNoteDraft() {
  const np = state.notePop;
  if (!np || np.mode !== 'line') return;
  const existing = np.noteId ? state.notes.find((n) => n.id === np.noteId) : null;
  const v = noteText.value;
  const unchanged = existing ? v === existing.text : !v.trim();
  if (unchanged) state.noteDrafts.delete(np.index);
  else state.noteDrafts.set(np.index, v);
}

function closeNotePopover(keepDraft) {
  if (!state.notePop) return;
  if (keepDraft) stashNoteDraft();
  else state.noteDrafts.delete(state.notePop.index);
  state.notePop = null;
  notePop.hidden = true;
  ta.focus();
}

async function postLineNote(action, note) {
  await flushDraftSave();
  const out = await apiPost('/line_note', {
    action,
    note,
    title: titleEl.value,
    draft_text: ta.value,
    consult_id: consultId(),
    panel_item: state.selected ? state.selected.item_id : null,
    client_ts: nowIso(),
  });
  setOnline();

  const srv = new Map((out.annotations || []).map((n) => [n.id, n]));
  const mine = state.notes.filter((n) => n.id !== note.id);
  if (action !== 'delete') {
    const stamped = srv.get(note.id) || {};
    mine.push({ ...note, ...stamped, line_index: note.line_index, line_text: note.line_text,
      anchor_text: note.anchor_text, status: note.status, text: note.text });
  }
  state.notes = mine;
  return out;
}

async function saveNote() {
  const np = state.notePop;
  if (!np || np.mode !== 'line') return;
  const text = noteText.value.trim();
  const existing = np.noteId ? state.notes.find((n) => n.id === np.noteId) : null;
  if (!text) {
    if (existing) return deleteNote();
    closeNotePopover(false);
    return;
  }

  const index = existing && existing.status === 'anchored' ? existing.line_index : np.index;
  const line = lines()[index];
  if (line === undefined || !line.trim()) {
    flashNote('this note has no line any more — see the detached notes');
    return;
  }
  const note = existing
    ? { ...existing, text, line_index: index, line_text: line, anchor_text: line, status: 'anchored' }
    : { id: randomId('n'), line_index: index, line_text: line, anchor_text: line, text,
      status: 'anchored' };
  try {
    await postLineNote(existing ? 'edit' : 'create', note);
    state.noteDrafts.delete(np.index);
    closeNotePopover(false);
    rebuildGutter();
    scheduleSave();
  } catch (e) {
    setOffline();
    flashNote('could not save the note — it is kept here, try again');
  }
}

async function deleteNote() {
  const np = state.notePop;
  if (!np || !np.noteId) return;
  const existing = state.notes.find((n) => n.id === np.noteId);
  if (!existing) { closeNotePopover(false); return; }
  try {
    await postLineNote('delete', existing);
    closeNotePopover(false);
    rebuildGutter();
    scheduleSave();
  } catch (e) {
    setOffline();
    flashNote('could not delete the note — try again');
  }
}

function renderDetachedCount() {
  const btn = $('#detached-notes');
  const n = orphanNotes().length;
  if (!n) { btn.hidden = true; return; }
  btn.hidden = false;
  btn.textContent = n === 1 ? '1 note lost its line · show' : n + ' notes lost their lines · show';
}

function openDetachedList() {
  const orphans = orphanNotes();
  if (!orphans.length) return;
  if (state.annotated) toggleAnnotated(false);
  state.notePop = { index: state.caretIndex, noteId: null, mode: 'detached' };
  $('#note-pop-line').textContent = 'detached notes — attach one to the caret line (' +
    (state.caretIndex + 1) + ') or delete it';
  noteText.value = '';
  noteText.hidden = true;
  $('#note-pop-actions').hidden = true;
  const box = $('#note-pop-detached');
  box.textContent = '';
  for (const n of orphans) {
    const row = el('div', 'detached-row');
    row.appendChild(el('span', 'was', 'was on “' + truncate(n.line_text, 40) + '”'));
    row.appendChild(el('span', 'note-text', n.text));
    const attach = el('button', null, 'attach here');
    attach.type = 'button';
    attach.addEventListener('click', () => attachDetached(n.id));
    const del = el('button', null, 'delete');
    del.type = 'button';
    del.addEventListener('click', async () => {
      try {
        await postLineNote('delete', n);
        rebuildGutter();
        scheduleSave();
        if (orphanNotes().length) openDetachedList(); else closeDetached();
      } catch (e) { setOffline(); flashNote('could not delete the note — try again'); }
    });
    row.appendChild(attach);
    row.appendChild(del);
    box.appendChild(row);
  }
  box.hidden = false;
  notePop.hidden = false;
  const top = PAD_TOP + (state.caretIndex + 1) * LH - ta.scrollTop + 2;
  notePop.style.top = Math.max(0, Math.min(top, ta.clientHeight - notePop.offsetHeight - 4)) + 'px';
  const first = box.querySelector('button');
  if (first) first.focus({ preventScroll: true });
}

function closeDetached() {
  noteText.hidden = false;
  $('#note-pop-actions').hidden = false;
  $('#note-pop-detached').hidden = true;
  $('#editor-wrap').scrollTop = 0;
  closeNotePopover(false);
}

async function attachDetached(noteId) {
  const index = state.caretIndex;
  const line = lines()[index];
  if (line === undefined || !line.trim()) {
    flashNote('put the caret on a line first');
    return;
  }
  if (noteAt(index)) {
    flashNote('line ' + (index + 1) + ' already has a note — edit that one, or move the caret');
    return;
  }
  const updated = Anchor.attach(state.notes, noteId, index, line);
  const note = updated.find((n) => n.id === noteId);
  try {

    state.notes = updated;
    await postLineNote('attach', note);
    closeDetached();
    rebuildGutter();
    scheduleSave();
  } catch (e) {
    setOffline();
    flashNote('could not attach the note — try again');
  }
}

$('#note-save').addEventListener('click', saveNote);
$('#note-delete').addEventListener('click', deleteNote);
$('#detached-notes').addEventListener('click', openDetachedList);
noteText.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    saveNote();
  }
});
ta.addEventListener('scroll', () => {
  if (state.notePop && state.notePop.mode === 'detached') closeDetached();
});

function annotatedMarkdown() {
  const title = titleEl.value.trim();
  const out = [title ? '# ' + title : '# (untitled)', ''];
  const ls = lines();
  ls.forEach((line, i) => {
    out.push(line);
    const n = noteAt(i);
    if (n && n.text.trim()) for (const gl of n.text.split('\n')) out.push('    > ' + gl);
  });
  const orphans = orphanNotes();
  if (orphans.length) {
    out.push('', '## detached notes', '');
    for (const n of orphans) out.push('- (was on: “' + n.line_text + '”) ' + n.text);
  }
  return out.join('\n').replace(/\s+$/, '') + '\n';
}

function renderAnnotated() {
  const body = $('#annotated-body');
  body.textContent = '';
  const ls = lines();
  ls.forEach((line, i) => {
    const n = noteAt(i);
    const row = el('div', 'annot-line' + (n ? ' has-gloss' : ''), line || ' ');
    body.appendChild(row);
    if (n) body.appendChild(el('div', 'annot-gloss', n.text));
  });
  const orphans = orphanNotes();
  if (orphans.length) {
    body.appendChild(el('div', 'card-title annot-detached-title', 'detached notes'));
    for (const n of orphans) {
      body.appendChild(el('div', 'annot-detached', '(was on “' + n.line_text + '”) ' + n.text));
    }
  }
}

function toggleAnnotated(open) {
  state.annotated = open === undefined ? !state.annotated : open;
  if (state.annotated && state.notePop) {
    if (state.notePop.mode === 'detached') closeDetached();
    else closeNotePopover(true);
  }
  $('#annotated-toggle').setAttribute('aria-pressed', String(state.annotated));
  $('#editor-wrap').hidden = state.annotated;
  $('#annotated-view').hidden = !state.annotated;
  $('#annotated-note').hidden = true;
  if (state.annotated) renderAnnotated();
  else ta.focus();
  postEvent('annotated_view', { open: state.annotated, notes: state.notes.length });
}

$('#annotated-toggle').addEventListener('click', () => toggleAnnotated());

function annotatedFilename() {
  const t = titleEl.value.trim().toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-|-$/g, '');
  return (t || 'poem') + '-annotated.md';
}

$('#annotated-copy').addEventListener('click', async () => {
  const note = $('#annotated-note');
  try {
    await navigator.clipboard.writeText(annotatedMarkdown());
    note.textContent = 'copied';
  } catch (e) {
    note.textContent = 'could not copy — use Download';
  }
  note.hidden = false;
});

$('#annotated-download').addEventListener('click', () => {
  const blob = new Blob([annotatedMarkdown()], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = annotatedFilename();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  const note = $('#annotated-note');
  note.textContent = 'downloaded ' + a.download;
  note.hidden = false;
});

const mainEl = document.querySelector('main');
const COLS_KEY = 'poemarium.cols';
const MIN_COL = [300, 320, 260];

function currentCols() {
  return [$('#editor-pane'), $('#field-col'), $('#item-pane')]
    .map((n) => Math.round(n.getBoundingClientRect().width));
}

function applyCols(cols) {
  mainEl.style.gridTemplateColumns =
    cols[0] + 'px var(--split-w) minmax(0, 1fr) var(--split-w) ' + cols[2] + 'px';
}

function loadCols() {
  try {
    const saved = JSON.parse(localStorage.getItem(COLS_KEY) || 'null');
    if (Array.isArray(saved) && saved.length === 3 && saved.every((x) => Number.isFinite(x))) {
      applyCols(saved);
    }
  } catch (e) {                        }
}

function saveCols() {
  try { localStorage.setItem(COLS_KEY, JSON.stringify(currentCols())); } catch (e) {              }
}

function resetCols() {
  mainEl.style.gridTemplateColumns = '';
  try { localStorage.removeItem(COLS_KEY); } catch (e) {              }
}

function setupSplitter(id, side) {
  const sp = document.getElementById(id);
  let startX = 0;
  let startCols = null;
  const gap = 8 + 6;
  const onMove = (e) => {
    if (!startCols) return;
    const dx = e.clientX - startX;
    const total = mainEl.getBoundingClientRect().width;
    const cols = startCols.slice();
    if (side === 0) cols[0] = startCols[0] + dx;
    else cols[2] = startCols[2] - dx;
    cols[0] = Math.max(MIN_COL[0], cols[0]);
    cols[2] = Math.max(MIN_COL[2], cols[2]);
    const middle = total - cols[0] - cols[2] - 2 * gap;
    if (middle < MIN_COL[1]) {
      if (side === 0) cols[0] = total - cols[2] - 2 * gap - MIN_COL[1];
      else cols[2] = total - cols[0] - 2 * gap - MIN_COL[1];
    }
    applyCols(cols);
  };
  const onUp = () => {
    if (!startCols) return;
    startCols = null;
    sp.classList.remove('dragging');
    document.body.classList.remove('resizing');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    saveCols();
  };
  sp.addEventListener('pointerdown', (e) => {
    if (state.panelMode !== 'column') return;
    startX = e.clientX;
    startCols = currentCols();
    sp.classList.add('dragging');
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    e.preventDefault();
  });
  sp.addEventListener('dblclick', resetCols);
  sp.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    startX = 0;
    startCols = currentCols();
    onMove({ clientX: e.key === 'ArrowLeft' ? -16 : 16 });
    startCols = null;
    saveCols();
  });
}

setupSplitter('split-editor', 0);
setupSplitter('split-item', 2);

$('#help-btn').addEventListener('click', () => {
  $('#help-overlay').hidden = false;
  $('#help-close').focus();
  postEvent('help_open', {});
});
$('#help-close').addEventListener('click', () => {
  $('#help-overlay').hidden = true;
  $('#help-btn').focus();
});

let dialogLastFocus = null;

function openDialog() {
  dialogLastFocus = document.activeElement;
  $('#dialog-overlay').hidden = false;
  const first = document.querySelector('#reflect-questions textarea');
  if (first) first.focus();
}

function closeDialog() {

  $('#dialog-overlay').hidden = true;
  $('#dialog-error').hidden = true;
  if (dialogLastFocus && typeof dialogLastFocus.focus === 'function') {
    dialogLastFocus.focus();
  }
  dialogLastFocus = null;
}

function reflectionAnswers() {
  return Array.from(document.querySelectorAll('#reflect-questions textarea')).map((t) => ({
    id: t.dataset.q,
    question: t.parentElement.querySelector('span').textContent,
    text: t.value.trim(),
  }));
}

async function finishSession(withNote) {
  const answers = reflectionAnswers();
  const key = JSON.stringify(answers.map((a) => a.text));
  try {

    await flushDraftSave();
    if (withNote && state.noteSentText !== key) {

      await apiPost('/session_reflection', { schema_id: 'session-notes-v1', answers, client_ts: nowIso() });
      state.noteSentText = key;
    }

    const out = await apiPost('/event', eventBody('session_end', {
      notes_client: state.notes.length, pins_client: state.pins.length,
    }));
    setOnline();
    if (state.session) state.session.ended_utc = nowIso();
    renderSessionControls();
    $('#session-pill-text').textContent = out && out.export
      ? 'Session ended · exported' : 'Session ended';
    for (const t of document.querySelectorAll('#reflect-questions textarea')) t.value = '';
    closeDialog();
  } catch (e) {

    setOffline();
    $('#dialog-error').hidden = false;
  }
}

$('#end-session').addEventListener('click', () => { if (!readOnlyGuard()) openDialog(); });

function openNewSessionDialog() {
  if (state.readOnlyConflict) { readOnlyGuard(); return; }
  $('#new-session-error').hidden = true;
  $('#new-session-overlay').hidden = false;
  $('#new-session-continue').focus();
}

function closeNewSessionDialog() {
  $('#new-session-overlay').hidden = true;
  $('#new-session').focus();
}

async function startNewSession(clearPoem) {
  try {
    await apiPost('/session/start', { clear_poem: clearPoem, client_ts: nowIso() });

    window.location.reload();
  } catch (e) {
    setOffline();
    $('#new-session-error').hidden = false;
  }
}

$('#new-session').addEventListener('click', openNewSessionDialog);
$('#start-here').addEventListener('click', openNewSessionDialog);
$('#new-session-cancel').addEventListener('click', closeNewSessionDialog);
$('#new-session-continue').addEventListener('click', () => startNewSession(false));
$('#new-session-empty').addEventListener('click', () => startNewSession(true));
$('#dialog-skip').addEventListener('click', () => finishSession(false));
$('#dialog-save').addEventListener('click', () => finishSession(true));

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#dialog-overlay').hidden) {
    closeDialog();
    return;
  }
  if (!$('#help-overlay').hidden) {
    $('#help-overlay').hidden = true;
    $('#help-btn').focus();
    return;
  }
  if (!$('#new-session-overlay').hidden) {
    closeNewSessionDialog();
    return;
  }
  if (!$('#reflect-box').hidden) {
    closeReflectBox(true);
    return;
  }
  if (state.notePop) {
    if (state.notePop.mode === 'detached') closeDetached();
    else closeNotePopover(true);
    return;
  }
  if (state.annotated) {
    toggleAnnotated(false);
    return;
  }
  if (state.panelMode === 'slide' && $('#item-pane').classList.contains('open')) {
    closeItem();
    return;
  }
  if (state.zoom !== 1) {
    state.zoom = 1;
    applyZoom();
  }
});

window.addEventListener('pagehide', () => {
  const savePending = draftDirty || !!saveTimer;
  if (savePending && draftLoaded) {
    if (saveTimer) clearTimeout(saveTimer);
    if (saveRetryTimer) clearTimeout(saveRetryTimer);
    saveTimer = null;
    saveRetryTimer = null;
    navigator.sendBeacon('/draft', jsonBlob(draftBody()));
  }
  for (const body of eventQueue.splice(0)) {
    navigator.sendBeacon('/event', jsonBlob(body));
  }
  navigator.sendBeacon('/event', jsonBlob(eventBody('page_hide', {
    draft_save_was_pending: savePending,
  })));
});

function renderSessionControls() {
  const s = state.session;
  const none = !s;
  const ended = !!(s && s.ended_utc);
  state.noSession = none;
  state.ended = ended;
  $('#end-session').hidden = none || ended;
  $('#new-session').hidden = !(none || ended);
  $('#new-session').lastChild.textContent = 'Start session';

  $('#start-banner').hidden = !(none || ended);
  $('#start-banner-text').textContent = ended
    ? 'This session has ended. Start a new one to write, consult and pin.'
    : 'No session is open. Start one to write, consult and pin.';
  const pill = $('#session-pill');
  pill.classList.toggle('ended', ended);
  $('#session-pill-text').textContent = none ? 'No session' : (ended ? 'Session ended' : 'Session active');
  ta.readOnly = none || ended || state.readOnlyConflict;
  titleEl.readOnly = none || ended || state.readOnlyConflict;
  renderMediationButtons();
}

function renderStatus(cfg) {
  state.mediationAvailable = !!(cfg.mediation && cfg.mediation.available);
  const s = state.session || {};

  const meta = $('#status-meta');
  meta.textContent = '';
  meta.hidden = true;
  $('#session-pill').title = [
    cfg.model_name,
    (cfg.archive_hash || '').slice(0, 8),
    s.session_id,
    s.resumed ? 'resumed' : null,
  ].filter(Boolean).join(' · ');
  renderSessionControls();
}

function pageLoadPayload(reason) {
  return {
    reason,
    cols: currentCols(),
    viewport: [window.innerWidth, window.innerHeight],
    panel_mode: state.panelMode,
    pins: state.pins.map((p) => p.item_id),
    notes: state.notes.length,
    notes_detached: orphanNotes().length,
    field_constants: FIELD_CONSTANTS,
  };
}

let channel = null;

function claimWriter() {
  if (typeof BroadcastChannel === 'undefined') return;
  channel = new BroadcastChannel('poemarium-iteration2');
  channel.onmessage = (ev) => {
    const m = ev.data || {};
    if (m.type !== 'hello' || m.page_id === state.pageId) return;
    if (state.readOnlyConflict) state.otherPageId = m.page_id;
    else yieldWriting(m.page_id);
  };
  channel.postMessage({ type: 'hello', page_id: state.pageId });
}

function yieldWriting(otherPageId) {
  state.readOnlyConflict = true;
  state.otherPageId = otherPageId;
  ta.readOnly = true;
  titleEl.readOnly = true;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (saveRetryTimer) { clearTimeout(saveRetryTimer); saveRetryTimer = null; }
  closeNotePopover(true);
  closeReflectBox(true);
  $('#write-banner').hidden = false;
  postEvent('page_conflict', { other_page_id: otherPageId, role: 'yielded' });
}

function applyState(st) {
  state.pins = st.pins || [];
  state.session = st.session || null;
  state.runId = st.run_id || null;
  state.reflections = (st.session && st.session.reflections) || {};
  if (st.draft) {
    titleEl.value = st.draft.title || '';
    state.notes = st.draft.annotations || [];
    setDraftText(st.draft.text || '');
  }
  draftDirty = false;
  state.mediations = (st.session && st.session.mediations) || [];
  renderStatus(st.config || {});
  rebuildGutter();
  renderPins();
  renderReflectToggle();
  renderMediationCards();
}

async function takeOver() {
  let st;
  try {
    st = await apiGet('/state');
  } catch (e) {
    setOffline();
    flashNote('could not reach the archive server — try again');
    return;
  }
  applyState(st);
  state.readOnlyConflict = false;
  ta.readOnly = false;
  titleEl.readOnly = false;
  $('#write-banner').hidden = true;
  if (channel) channel.postMessage({ type: 'hello', page_id: state.pageId });
  postEvent('page_conflict', { other_page_id: state.otherPageId, role: 'took_over' });
  ta.focus();
}

$('#take-over').addEventListener('click', takeOver);

let initRetryTimer = null;

async function init() {
  measureEditor();
  updatePanelMode();
  claimWriter();
  try {
    const [st, arch] = await Promise.all([apiGet('/state'), apiGet('/archive')]);
    for (const it of arch.items || []) state.itemsById.set(it.item_id, it);
    state.sources = arch.sources || {};
    state.pins = st.pins || [];
    state.session = st.session || null;
    state.reflections = (st.session && st.session.reflections) || {};
    state.runId = st.run_id || null;
    if (st.draft) {
      titleEl.value = st.draft.title || '';
      state.notes = st.draft.annotations || [];
      setDraftText(st.draft.text || '');
    }
    draftLoaded = true;
    state.mediations = (st.session && st.session.mediations) || [];
    const cfg = st.config || {};
    renderStatus(cfg);
    setOnline();
    wasOffline = false;
    postEvent('page_load', pageLoadPayload('load'));
    if (cfg.semantic_available === false) showFieldUnavailable(cfg.semantic_unavailable_reason);
  } catch (e) {

    ta.readOnly = true;
    $('#status-meta').textContent = 'archive server unreachable — retrying…';
    $('#status-meta').hidden = false;
    setOffline();
    if (!initRetryTimer) {
      initRetryTimer = setTimeout(() => {
        initRetryTimer = null;
        init();
      }, 4000);
    }
  }
  rebuildGutter();
  renderPins();
  renderConsultStrip();
  ta.focus();
  ta.scrollLeft = 0;
}

init();
