// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Same answers on every case, faster: the reference reads one character at a
// time and grows each field a character at a time. This reader instead jumps
// with indexOf to the next thing that can end a field and cuts fields out
// with slice, so the common field costs a few native scans instead of a
// loop over its characters. Only the rare broken shapes (a stray CR inside
// an unquoted field, doubled quotes or a line break inside a quoted field,
// junk after a closing quote, a quote that never closes) take a slower path.
//
// Semantics (the reference's, exactly):
// - a U+FEFF at the very start is dropped;
// - a record ends at LF or CRLF, and a line left with no characters is no record;
// - outside quotes a CR not followed by LF is dropped (error stray_cr);
// - a field that opens with a quote runs to the next quote that is not
//   doubled, "" inside it one quote and each CRLF or lone CR inside it read
//   as LF; what follows its closing quote, up to the next comma or line
//   break, is appended as it stands (quote_junk, when the field ends); a
//   quote that never closes is a literal character, and the text after it is
//   read again as unquoted (unterminated_quote);
// - a quote inside an unquoted field is a literal character; fields stay
//   strings, never trimmed or converted;
// - columns is the first record when header is true, else null; rows holds
//   the records after it (every record when header is false), each padded
//   with empty strings (short_row, with fields: its field count) or cut
//   (long_row, with extra: the cut fields) to the first record's width;
// - each error is {code, line, row}, in the order met, a record's short_row
//   or long_row when it ends: line the 1-based line its record starts on,
//   counting every LF, CRLF and lone CR inside quotes, and row its record's
//   index in rows, null for the header.

// How a field ended: 0 at a comma, 1 at a line break, 2 at the end of the text.
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/**
 * Read an unquoted field starting at `pos`, appending onto `init`.
 * Returns {value, ended, pos, line, added}; `added` counts the characters
 * kept by this call. Handles stray CRs (dropped, error stray_cr). This is
 * the slow path, used only for junk after a closing quote and for the
 * re-read after an unterminated quote; the hot unquoted read is inline in
 * run() below.
 */
function readUnquoted(text, len, pos, line, errors, recordLine, recordRow, init) {
  // Field end: the next comma or LF, or the end of the text.
  const c = text.indexOf(',', pos);
  const n = text.indexOf('\n', pos);
  let end;
  let ended;
  if (c !== -1 && (n === -1 || c < n)) {
    end = c;
    ended = COMMA;
  } else if (n !== -1) {
    end = n;
    ended = LINE_BREAK;
  } else {
    end = len;
    ended = END;
  }
  // A CRLF line break ends the content one character early.
  let contentEnd = end;
  if (ended === LINE_BREAK && end > pos && text.charCodeAt(end - 1) === 13) contentEnd = end - 1;
  // Drop every CR in [pos, contentEnd), one stray_cr error each.
  let value = init;
  let added = 0;
  let seg = pos;
  let r = pos;
  while (true) {
    r = text.indexOf('\r', r);
    if (r === -1 || r >= contentEnd) break;
    errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
    value += text.slice(seg, r);
    added += r - seg;
    r += 1;
    seg = r;
  }
  value += text.slice(seg, contentEnd);
  added += contentEnd - seg;
  if (ended === COMMA) pos = end + 1;
  else if (ended === LINE_BREAK) {
    pos = end + 1;
    line += 1;
  } else {
    pos = end;
  }
  return { value, ended, pos, line, added };
}

/**
 * Build a quoted field's value from its content in [start, end): every ""
 * becomes one quote, every CRLF or lone CR or LF becomes one LF.
 * Returns {value, breaks}, `breaks` the line breaks inside the content
 * (each CRLF, lone CR and LF counts once).
 */
function quotedContent(text, start, end) {
  let value = '';
  let breaks = 0;
  let p = start;
  while (p < end) {
    const q = text.indexOf('"', p);
    const r = text.indexOf('\r', p);
    const n = text.indexOf('\n', p);
    let m = end;
    let kind = 0; // 1 quote, 2 CR, 3 LF
    if (q !== -1 && q < m) {
      m = q;
      kind = 1;
    }
    if (r !== -1 && r < m) {
      m = r;
      kind = 2;
    }
    if (n !== -1 && n < m) {
      m = n;
      kind = 3;
    }
    value += text.slice(p, m);
    if (m >= end) break;
    if (kind === 1) {
      // Inside a quoted field every quote is part of a doubled pair.
      value += '"';
      p = m + 2;
    } else if (kind === 2) {
      value += '\n';
      breaks += 1;
      p = text.charCodeAt(m + 1) === 10 ? m + 2 : m + 1;
    } else {
      value += '\n';
      breaks += 1;
      p = m + 1;
    }
  }
  return { value, breaks };
}

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const len = text.length;
  let pos = 0;
  let line = 1;
  if (len > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const ch = text.charCodeAt(pos);
      if (ch === 10) {
        pos += 1;
        line += 1;
      } else if (ch === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;

    // Fast path: a whole plain line (no quote, no stray CR) splits in C++.
    // A quote anywhere on the line, or a CR that is not the CRLF at its
    // end, falls through to the field-by-field reader below.
    const lineEnd = text.indexOf('\n', pos);
    const le = lineEnd === -1 ? len : lineEnd;
    const qPos = text.indexOf('"', pos);
    if (qPos === -1 || qPos >= le) {
      const isCRLF = lineEnd !== -1 && le > pos && text.charCodeAt(le - 1) === 13;
      const contentEnd = isCRLF ? le - 1 : le;
      const content = text.slice(pos, contentEnd);
      if (content.indexOf('\r') === -1) {
        const fields = content.split(',');
        if (width < 0) width = fields.length;
        if (header && columns === null) {
          columns = fields;
        } else {
          if (fields.length < width) {
            errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
            while (fields.length < width) fields.push('');
          } else if (fields.length > width) {
            errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
          }
          rows.push(fields);
        }
        if (lineEnd === -1) pos = len;
        else {
          pos = lineEnd + 1;
          line += 1;
        }
        continue;
      }
    }

    // The line end found above (le) is the next LF at or after this
    // record's start; unquoted fields reuse it instead of searching for
    // the next LF again per field. A quoted field may span lines, so it
    // invalidates the cache.
    let cachedLe = le;
    let leValid = true;

    const fields = [];
    let ended = COMMA;
    let quoted = false;

    do {
      if (text.charCodeAt(pos) === 34) {
        // ---- A field that opens with a quote. ----
        quoted = true;
        const open = pos;
        const openLine = line;
        // Find its closing quote, skipping doubled "" pairs.
        let q = pos + 1;
        let closePos = -1;
        let hasDoubled = false;
        while (true) {
          const qi = text.indexOf('"', q);
          if (qi === -1) break;
          if (text.charCodeAt(qi + 1) === 34) {
            hasDoubled = true;
            q = qi + 2;
            continue;
          }
          closePos = qi;
          break;
        }
        if (closePos === -1) {
          // The quote never closes: it is a literal character, and the
          // text after it is read again as unquoted.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          pos = open + 1;
          line = openLine;
          quoted = false;
          const r = readUnquoted(text, len, pos, line, errors, recordLine, recordRow, '"');
          fields.push(r.value);
          ended = r.ended;
          pos = r.pos;
          line = r.line;
          leValid = false;
          continue;
        }
        // The content is [open + 1, closePos). Slice it once and check
        // the slice itself for a line break, so the check stays inside
        // the field instead of scanning on past it.
        const cs = open + 1;
        const content = text.slice(cs, closePos);
        let value;
        if (!hasDoubled && content.indexOf('\r') === -1 && content.indexOf('\n') === -1) {
          value = content;
        } else if (hasDoubled && content.indexOf('\r') === -1 && content.indexOf('\n') === -1) {
          // Doubled quotes only, no line break: C++ split/join.
          value = content.split('""').join('"');
        } else {
          const built = quotedContent(text, cs, closePos);
          value = built.value;
          line += built.breaks;
        }
        // What follows the closing quote.
        leValid = false;
        pos = closePos + 1;
        if (pos >= len) {
          ended = END;
          fields.push(value);
        } else {
          const c = text.charCodeAt(pos);
          if (c === 44) {
            pos += 1;
            ended = COMMA;
            fields.push(value);
          } else if (c === 10) {
            pos += 1;
            line += 1;
            ended = LINE_BREAK;
            fields.push(value);
          } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
            pos += 2;
            line += 1;
            ended = LINE_BREAK;
            fields.push(value);
          } else {
            // Junk after the closing quote, appended as it stands.
            const r = readUnquoted(text, len, pos, line, errors, recordLine, recordRow, value);
            if (r.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
            fields.push(r.value);
            ended = r.ended;
            pos = r.pos;
            line = r.line;
            leValid = false;
          }
        }
      } else {
        // ---- An unquoted field (the hot path). ----
        // Its end is the next comma or the cached line end, whichever is
        // first; slice it, then check the slice itself for a CR: a CR
        // search on the whole text would run on past this field when the
        // next CR is far away.
        quoted = false;
        if (!leValid) {
          const nl = text.indexOf('\n', pos);
          cachedLe = nl === -1 ? len : nl;
          leValid = true;
        }
        const c = text.indexOf(',', pos);
        const n = cachedLe;
        let end;
        let endKind;
        if (c !== -1 && c < n) {
          end = c;
          endKind = COMMA;
        } else if (n < len) {
          end = n;
          endKind = LINE_BREAK;
        } else {
          end = len;
          endKind = END;
        }
        let contentEnd = end;
        if (endKind === LINE_BREAK && end > pos && text.charCodeAt(end - 1) === 13) {
          contentEnd = end - 1; // CRLF: the field ends one character early.
        }
        const field = text.slice(pos, contentEnd);
        if (field.indexOf('\r') !== -1) {
          // A stray CR inside: take the slow path for this field only.
          const res = readUnquoted(text, len, pos, line, errors, recordLine, recordRow, '');
          fields.push(res.value);
          ended = res.ended;
          pos = res.pos;
          line = res.line;
          leValid = false;
        } else {
          fields.push(field);
          if (endKind === COMMA) {
            pos = end + 1;
            ended = COMMA;
          } else if (endKind === LINE_BREAK) {
            pos = end + 1;
            line += 1;
            ended = LINE_BREAK;
          } else {
            pos = end;
            ended = END;
          }
        }
      }
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
