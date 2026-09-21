'use strict';

//Keep note anchors aligned after line edits.
(function () {
  const ANCHORED = 'anchored';
  const ORPHANED = 'orphaned';

  function asString(text) {
    return typeof text === 'string' ? text : '';
  }

  function toLines(text) {
    return asString(text).split('\n');
  }

  function countNewlines(s, from, to) {
    let n = 0;
    for (let k = from; k < to; k++) {
      if (s.charCodeAt(k) === 10) n++;
    }
    return n;
  }

  function isBlank(line) {
    return typeof line !== 'string' || line.trim() === '';
  }

  function copy(note) {
    return { ...note };
  }

  function anchored(note, index, text) {
    const out = { ...note, line_index: index, line_text: text, status: ANCHORED };
    delete out._rule;
    return out;
  }

  function orphan(note) {
    const out = { ...note, status: ORPHANED };
    delete out._rule;
    return out;
  }

  function indicesOf(lines, text, from, to) {
    const hits = [];
    const lo = Math.max(0, from);
    const hi = Math.min(lines.length - 1, to);
    for (let k = lo; k <= hi; k++) {
      if (lines[k] === text) hits.push(k);
    }
    return hits;
  }

  function settle(note, target, lines, rule) {
    if (!Number.isInteger(target) || target < 0 || target >= lines.length) return orphan(note);
    const text = lines[target];
    if (isBlank(text)) return orphan(note);
    const out = anchored(note, target, text);
    if (rule !== undefined) out._rule = rule;
    return out;
  }

  function enforceOnePerLine(results, originals) {
    const out = results.slice();
    const owner = new Map();
    const sureness = (n) => (Number.isInteger(n._rule) ? n._rule : 0);
    for (let k = 0; k < out.length; k++) {
      if (out[k].status !== ANCHORED) continue;
      const idx = out[k].line_index;
      if (!owner.has(idx)) {
        owner.set(idx, k);
        continue;
      }
      const j = owner.get(idx);
      const kWins = sureness(out[k]) < sureness(out[j]) ||
        (sureness(out[k]) === sureness(out[j]) &&
          originals[k].line_index < originals[j].line_index);
      if (kWins) {
        out[j] = orphan(originals[j]);
        owner.set(idx, k);
      } else {
        out[k] = orphan(originals[k]);
      }
    }
    return out.map((n) => { const c = { ...n }; delete c._rule; return c; });
  }

  function diffLines(oldText, newText) {
    const o = asString(oldText);
    const n = asString(newText);
    if (o === n) return null;
    const minLen = Math.min(o.length, n.length);
    let p = 0;
    while (p < minLen && o.charCodeAt(p) === n.charCodeAt(p)) p++;
    let s = 0;
    while (s < minLen - p && o.charCodeAt(o.length - 1 - s) === n.charCodeAt(n.length - 1 - s)) s++;
    const a = countNewlines(o, 0, p);
    const b = a + countNewlines(o, p, o.length - s);
    const c = a + countNewlines(n, p, n.length - s);
    return { a, b, c };
  }

  function placeInsideRegion(note, i, d, oldLines, newLines) {
    const { a, b, c } = d;

    const hits = indicesOf(newLines, note.line_text, a, c);
    if (hits.length === 1) return { index: hits[0], rule: 1 };

    if (a === b) {
      if (c > a) {
        const saved = typeof note.anchor_text === 'string' ? note.anchor_text : '';
        if (saved.trim()) {
          const exact = indicesOf(newLines, saved, a, c);
          if (exact.length === 1) return { index: exact[0], rule: 2 };
          const containing = [];
          for (let k = a; k <= Math.min(c, newLines.length - 1); k++) {
            if (newLines[k].includes(saved)) containing.push(k);
          }
          if (containing.length === 1) return { index: containing[0], rule: 2 };
        }
      }
      return { index: a, rule: 2 };
    }

    if (b === c) return { index: i, rule: 3 };

    if (c === a) {
      if (i === a && newLines[a].startsWith(oldLines[a]) &&
          indicesOf(oldLines, newLines[a], a + 1, b).length === 0) {
        return { index: a, rule: 4 };
      }
      return { index: -1, rule: 4 };
    }

    return { index: -1, rule: 5 };
  }

  function placeNote(note, d, oldLines, newLines) {
    if (note.status === ORPHANED) return copy(note);
    const i = note.line_index;
    if (!Number.isInteger(i)) return orphan(note);
    const { a, b, c } = d;
    let target;
    let rule = 0;
    if (i < a) {
      target = i;
    } else if (i > b) {
      target = i + (c - b);
    } else {
      const placed = placeInsideRegion(note, i, d, oldLines, newLines);
      target = placed.index;
      rule = placed.rule;
    }
    return settle(note, target, newLines, rule);
  }

  function reanchorNotes(oldText, newText, notes) {
    const list = Array.isArray(notes) ? notes : [];
    const d = diffLines(oldText, newText);
    if (d === null) return list.map(copy);
    const oldLines = toLines(oldText);
    const newLines = toLines(newText);
    const placed = list.map((note) => placeNote(note, d, oldLines, newLines));
    return enforceOnePerLine(placed, list);
  }

  function reanchorOne(oldText, newText, anchor) {
    if (!anchor) return null;
    if (anchor.status === ORPHANED) return copy(anchor);
    const asNote = {
      line_index: anchor.index, line_text: anchor.text, status: ANCHORED,
      anchor_text: typeof anchor.anchor_text === 'string' ? anchor.anchor_text : anchor.text,
    };
    const [placed] = reanchorNotes(oldText, newText, [asNote]);
    return { ...anchor, index: placed.line_index, text: placed.line_text, status: placed.status };
  }

  function locateSaved(note, lines) {
    const i = note.line_index;
    if (lines[i] === note.line_text) return i;
    let matches = indicesOf(lines, note.line_text, 0, lines.length - 1);
    if (matches.length === 0 && typeof note.anchor_text === 'string' && note.anchor_text.trim()) {
      matches = indicesOf(lines, note.anchor_text, 0, lines.length - 1);
    }
    if (matches.length === 0) return -1;
    if (matches.length === 1) return matches[0];

    let best = -1;
    let bestDist = Infinity;
    let tie = false;
    for (const m of matches) {
      const dist = Math.abs(m - (Number.isInteger(i) ? i : 0));
      if (dist < bestDist) {
        best = m;
        bestDist = dist;
        tie = false;
      } else if (dist === bestDist) {
        tie = true;
      }
    }
    return tie ? -1 : best;
  }

  function reconcile(text, notes) {
    const list = Array.isArray(notes) ? notes : [];
    const lines = toLines(text);
    const placed = list.map((note) => {
      if (note.status === ORPHANED) return copy(note);
      return settle(note, locateSaved(note, lines), lines);
    });
    return enforceOnePerLine(placed, list);
  }

  function attach(notes, noteId, index, text) {
    const list = Array.isArray(notes) ? notes : [];
    if (!list.some((note) => note.id === noteId)) return list.map(copy);
    return list.map((note) => {
      if (note.id === noteId) return { ...anchored(note, index, text), anchor_text: text };
      if (note.status === ANCHORED && note.line_index === index) return orphan(note);
      return copy(note);
    });
  }

  function lineAt(text, index) {
    if (typeof text !== 'string' || !Number.isInteger(index) || index < 0) return null;
    const lines = text.split('\n');
    return index < lines.length ? lines[index] : null;
  }

  const Anchor = Object.freeze({
    ANCHORED,
    ORPHANED,
    diffLines,
    reanchorNotes,
    reanchorOne,
    reconcile,
    attach,
    lineAt,
  });

  if (typeof window !== 'undefined') window.Anchor = Anchor;
  if (typeof module !== 'undefined' && module.exports) module.exports = Anchor;
})();
