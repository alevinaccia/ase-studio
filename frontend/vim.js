/*
 * SPDX-License-Identifier: GPL-2.0-only
 */
// Vim keybindings for the Assembly editor textarea. The host supplies the
// editing primitives so undo history and protected lines keep working.
function createVimMode(host) {
  const editor = host.editor;
  const PROTECTED_MESSAGE = "Protected line: edit blocked";
  const WORD = /[A-Za-z0-9_]/;
  const PAIRS = {"(": ")", "[": "]", "{": "}", "<": ">"};
  const OBJECT_OPENERS = {"(": "(", ")": "(", b: "(", "[": "[", "]": "[", "{": "{", "}": "{", B: "{", "<": "<", ">": "<"};
  const ALIASES = {ArrowLeft: "h", ArrowDown: "j", ArrowUp: "k", ArrowRight: "l", Backspace: "h",
    " ": "l", Enter: "+", Home: "0", End: "$"};
  const MOTIONS = new Set(["h", "j", "k", "l", "w", "W", "b", "B", "e", "E", "0", "^", "$", "G",
    "{", "}", "%", ";", ",", "+", "-", "_", "n", "N"]);
  const OPERATORS = new Set(["d", "c", "y", ">", "<"]);
  const MODE_LABELS = {normal: "NORMAL", insert: "INSERT", visual: "VISUAL", "visual-line": "V-LINE"};

  let enabled = false;
  let mode = "normal";
  let cursor = 0;
  let anchor = 0;
  let desiredColumn = 0;
  let count = "";
  let operator = null;
  let operatorCount = "";
  let prefix = "";
  let message = "";
  let register = {text: "", linewise: false};
  let lastFind = null;
  let lastSearch = null;
  let rendered = {start: -1, end: -1};
  let commandKeys = [];
  let lastChange = null;
  let insertOrigin = null;
  let replaying = false;
  let commandRange = null;

  const text = () => editor.value;
  const lineStart = pos => pos > 0 ? text().lastIndexOf("\n", pos - 1) + 1 : 0;
  const lineEnd = pos => {
    const end = text().indexOf("\n", pos);
    return end < 0 ? text().length : end;
  };
  const column = pos => pos - lineStart(pos);
  const isVisual = () => mode === "visual" || mode === "visual-line";

  function firstNonBlank(pos) {
    const source = text();
    let position = lineStart(pos);
    const end = lineEnd(position);
    while (position < end && (source[position] === " " || source[position] === "\t")) position++;
    return position;
  }

  function lineNumberAt(pos) {
    const source = text();
    let lineNumber = 1;
    for (let index = source.indexOf("\n"); index >= 0 && index < pos; index = source.indexOf("\n", index + 1)) lineNumber++;
    return lineNumber;
  }

  function lineCount() {
    return lineNumberAt(text().length);
  }

  function moveLines(pos, delta) {
    const source = text();
    let start = lineStart(pos);
    for (let step = 0; step < Math.abs(delta); step++) {
      if (delta > 0) {
        const end = lineEnd(start);
        if (end >= source.length) break;
        start = end + 1;
      } else {
        if (start === 0) break;
        start = lineStart(start - 1);
      }
    }
    return start;
  }

  const lineStartOfNumber = lineNumber => moveLines(0, Math.max(1, lineNumber) - 1);
  const atColumn = (start, wanted) => Math.min(start + wanted, lineEnd(start));

  function clampNormal(pos) {
    pos = Math.max(0, Math.min(pos, text().length));
    const start = lineStart(pos);
    const end = lineEnd(pos);
    return end > start ? Math.min(pos, end - 1) : start;
  }

  function charClass(character, big) {
    if (character === undefined || /\s/.test(character)) return 0;
    if (big || WORD.test(character)) return 1;
    return 2;
  }

  function wordForward(pos, big, times) {
    const source = text();
    for (let step = 0; step < times && pos < source.length; step++) {
      const kind = charClass(source[pos], big);
      if (kind) while (pos < source.length && charClass(source[pos], big) === kind) pos++;
      while (pos < source.length && !charClass(source[pos], big)) {
        if (source[pos] === "\n" && source[pos + 1] === "\n") {
          pos++;
          break;
        }
        pos++;
      }
    }
    return pos;
  }

  function wordBackward(pos, big, times) {
    const source = text();
    for (let step = 0; step < times && pos > 0; step++) {
      pos--;
      while (pos > 0 && !charClass(source[pos], big)) {
        if (source[pos] === "\n" && source[pos - 1] === "\n") break;
        pos--;
      }
      const kind = charClass(source[pos], big);
      if (kind) while (pos > 0 && charClass(source[pos - 1], big) === kind) pos--;
    }
    return pos;
  }

  function wordEnd(pos, big, times) {
    const source = text();
    for (let step = 0; step < times && pos < source.length - 1; step++) {
      pos++;
      while (pos < source.length && !charClass(source[pos], big)) pos++;
      const kind = charClass(source[pos], big);
      while (pos + 1 < source.length && charClass(source[pos + 1], big) === kind) pos++;
    }
    return Math.min(pos, Math.max(0, source.length - 1));
  }

  function findCharacter(kind, character, times, pos, repeat) {
    const source = text();
    const start = lineStart(pos);
    const end = lineEnd(pos);
    const forward = kind === "f" || kind === "t";
    const direction = forward ? 1 : -1;
    let position = pos;
    for (let step = 0; step < times; step++) {
      let probe = position + direction;
      if (step === 0 && repeat && (kind === "t" || kind === "T")) probe += direction;
      while (probe >= start && probe < end && source[probe] !== character) probe += direction;
      if (probe < start || probe >= end) return null;
      position = probe;
    }
    if (kind === "t") position--;
    if (kind === "T") position++;
    return position;
  }

  function matchBracket(pos) {
    const source = text();
    const end = lineEnd(pos);
    let position = pos;
    while (position < end && !"()[]{}".includes(source[position])) position++;
    if (position >= end) return null;
    const character = source[position];
    const opening = "([{".includes(character);
    const other = {"(": ")", "[": "]", "{": "}", ")": "(", "]": "[", "}": "{"}[character];
    let depth = 0;
    for (let probe = position; probe >= 0 && probe < source.length; probe += opening ? 1 : -1) {
      if (source[probe] === character) depth++;
      else if (source[probe] === other && --depth === 0) return probe;
    }
    return null;
  }

  function paragraph(pos, forward, times) {
    const source = text();
    const blank = start => lineEnd(start) === start;
    let start = lineStart(pos);
    for (let step = 0; step < times; step++) {
      if (forward) {
        while (blank(start) && lineEnd(start) < source.length) start = lineEnd(start) + 1;
        while (!blank(start)) {
          const end = lineEnd(start);
          if (end >= source.length) return source.length;
          start = end + 1;
        }
      } else {
        while (blank(start) && start > 0) start = lineStart(start - 1);
        while (!blank(start)) {
          if (start === 0) return 0;
          start = lineStart(start - 1);
        }
      }
    }
    return start;
  }

  function searchFrom(query, pos, backward, times) {
    const source = text().toLowerCase();
    const needle = query.toLowerCase();
    let position = pos;
    for (let step = 0; step < times; step++) {
      let next = backward
        ? (position > 0 ? source.lastIndexOf(needle, position - 1) : -1)
        : source.indexOf(needle, position + 1);
      if (next < 0) {
        next = backward ? source.lastIndexOf(needle) : source.indexOf(needle);
        if (next >= 0) message = backward ? "Search hit TOP, continuing at BOTTOM" : "Search hit BOTTOM, continuing at TOP";
      }
      if (next < 0) {
        message = `Pattern not found: ${query}`;
        return null;
      }
      position = next;
    }
    return position;
  }

  function textObject(kind, key, pos) {
    const source = text();
    if (key === "w" || key === "W") {
      const big = key === "W";
      const start = lineStart(pos);
      const end = lineEnd(pos);
      if (start === end) return null;
      const wordKind = charClass(source[pos], big);
      let from = pos;
      let to = pos + 1;
      while (from > start && charClass(source[from - 1], big) === wordKind) from--;
      while (to < end && charClass(source[to], big) === wordKind) to++;
      if (kind === "a") {
        if (wordKind) {
          let after = to;
          while (after < end && !charClass(source[after], big)) after++;
          if (after > to) to = after;
          else while (from > start && !charClass(source[from - 1], big)) from--;
        } else {
          const nextKind = charClass(source[to], big);
          while (to < end && nextKind && charClass(source[to], big) === nextKind) to++;
        }
      }
      return {from, to};
    }
    if (`"'\``.includes(key)) {
      const start = lineStart(pos);
      const end = lineEnd(pos);
      const quotes = [];
      for (let position = start; position < end; position++) {
        if (source[position] === key && source[position - 1] !== "\\") quotes.push(position);
      }
      for (let index = 0; index + 1 < quotes.length; index += 2) {
        if (quotes[index + 1] < pos) continue;
        const [open, close] = [quotes[index], quotes[index + 1]];
        return kind === "i" ? {from: open + 1, to: close} : {from: open, to: close + 1};
      }
      return null;
    }
    const open = OBJECT_OPENERS[key];
    if (!open) return null;
    const close = PAIRS[open];
    let depth = 0;
    let from = -1;
    for (let position = pos; position >= 0; position--) {
      if (source[position] === close && position !== pos) depth++;
      else if (source[position] === open) {
        if (depth === 0) {
          from = position;
          break;
        }
        depth--;
      }
    }
    if (from < 0) return null;
    depth = 0;
    for (let position = from; position < source.length; position++) {
      if (source[position] === open) depth++;
      else if (source[position] === close && --depth === 0) {
        return kind === "i" ? {from: from + 1, to: position} : {from, to: position + 1};
      }
    }
    return null;
  }

  function change(start, end, replacement, caret) {
    return host.change(start, end, replacement, caret);
  }

  // Tries alternative ways of making the same edit, so an edit next to a
  // protected line can still succeed from the other side.
  function changeAny(...edits) {
    return edits.some(edit => edit && change(...edit));
  }

  function changeMinimal(from, to, replacement, caret) {
    const old = text().slice(from, to);
    let head = 0;
    while (head < old.length && head < replacement.length && old[head] === replacement[head]) head++;
    let tail = 0;
    while (tail < old.length - head && tail < replacement.length - head
        && old[old.length - 1 - tail] === replacement[replacement.length - 1 - tail]) tail++;
    if (head === old.length && head === replacement.length) return true;
    return change(from + head, to - tail, replacement.slice(head, replacement.length - tail), caret);
  }

  function setRegister(value, linewise) {
    register = {text: value, linewise};
  }

  function resetPending() {
    count = "";
    operator = null;
    operatorCount = "";
    prefix = "";
    commandKeys = [];
  }

  function finish({changed = false, insert = false} = {}) {
    if (insert) insertOrigin = {keys: commandKeys.slice(), text: text()};
    else if (changed && !replaying) lastChange = {keys: commandKeys.slice(), insertText: ""};
    resetPending();
    render();
  }

  function fail(reason = "") {
    message = reason;
    resetPending();
    render();
  }

  function startInsert(pos) {
    mode = "insert";
    editor.setSelectionRange(pos, pos);
    finish({insert: true});
  }

  function insertedText(before, after) {
    let head = 0;
    while (head < before.length && head < after.length && before[head] === after[head]) head++;
    let tail = 0;
    while (tail < before.length - head && tail < after.length - head
        && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
    return after.slice(head, after.length - tail);
  }

  function leaveInsert() {
    if (insertOrigin && !replaying) {
      lastChange = {keys: insertOrigin.keys, insertText: insertedText(insertOrigin.text, text())};
    }
    insertOrigin = null;
    mode = "normal";
    const pos = editor.selectionStart;
    cursor = pos > lineStart(pos) ? pos - 1 : pos;
    desiredColumn = column(cursor);
    render();
  }

  function visualRange() {
    const from = Math.min(anchor, cursor);
    const to = Math.max(anchor, cursor);
    if (mode === "visual-line") return {from: lineStart(from), to: lineEnd(to), linewise: true};
    return {from, to: Math.min(text().length, to + 1), linewise: false};
  }

  function motionRange(start, motion) {
    const from = Math.min(start, motion.pos);
    const to = Math.max(start, motion.pos);
    if (motion.linewise) return {from: lineStart(from), to: lineEnd(to), linewise: true};
    return {from, to: motion.inclusive ? Math.min(text().length, to + 1) : to, linewise: false};
  }

  function shiftLines(from, to, right, times = 1) {
    const block = text().slice(from, to);
    const shifted = block.split("\n").map(line => {
      for (let step = 0; step < times; step++) {
        if (right) line = line ? "    " + line : line;
        else line = line.startsWith("\t") ? line.slice(1) : line.replace(/^ {1,4}/, "");
      }
      return line;
    }).join("\n");
    const firstIndent = shifted.match(/^[\t ]*/)[0].length;
    return changeMinimal(from, to, shifted, from + firstIndent);
  }

  function operate(op, range, times = 1) {
    const source = text();
    const {from, to, linewise} = range;
    const content = source.slice(from, to);
    const registerText = linewise ? content + "\n" : content;
    mode = "normal";
    if (op === "y") {
      setRegister(registerText, linewise);
      cursor = linewise ? (lineStart(cursor) === from ? cursor : firstNonBlank(from)) : from;
      message = linewise && content.includes("\n") ? `${content.split("\n").length} lines yanked` : "";
      return finish();
    }
    if (op === "d") {
      const ok = linewise
        ? changeAny(to < source.length ? [from, to + 1, "", from] : null, from > 0 ? [from - 1, to, "", from - 1] : null,
          [from, to, "", from])
        : change(from, to, "", from);
      if (!ok) return fail(PROTECTED_MESSAGE);
      setRegister(registerText, linewise);
      cursor = linewise ? firstNonBlank(Math.min(editor.selectionStart, text().length)) : clampNormal(from);
      desiredColumn = column(cursor);
      return finish({changed: true});
    }
    if (op === "c") {
      const indent = linewise ? source.slice(from, firstNonBlank(from)) : "";
      if (!change(from, to, indent, from + indent.length)) return fail(PROTECTED_MESSAGE);
      setRegister(registerText, linewise);
      return startInsert(from + indent.length);
    }
    if (!shiftLines(lineStart(from), lineEnd(Math.max(from, to - (linewise ? 0 : 1))), op === ">", times)) {
      return fail(PROTECTED_MESSAGE);
    }
    cursor = firstNonBlank(from);
    return finish({changed: true});
  }

  function motion(spec, times, pending) {
    const source = text();
    const pos = cursor;
    const counted = Boolean(count || operatorCount);
    if (spec.find) {
      const target = findCharacter(spec.find, spec.character, times, pos, spec.repeat);
      return target === null ? null : {pos: target, inclusive: spec.find === "f" || spec.find === "t"};
    }
    switch (spec.key) {
      case "h": return {pos: Math.max(lineStart(pos), pos - times)};
      case "l": {
        const end = lineEnd(pos);
        return {pos: Math.min(pending ? end : Math.max(lineStart(pos), end - 1), pos + times)};
      }
      case "j": case "k": {
        const start = moveLines(pos, spec.key === "j" ? times : -times);
        if (start === lineStart(pos)) return null;
        return {pos: atColumn(start, desiredColumn), linewise: true, vertical: true};
      }
      case "+": case "-": case "_": {
        const delta = spec.key === "+" ? times : spec.key === "-" ? -times : times - 1;
        const start = moveLines(pos, delta);
        if (delta && start === lineStart(pos)) return null;
        return {pos: firstNonBlank(start), linewise: true};
      }
      case "w": case "W": return {pos: wordForward(pos, spec.key === "W", times)};
      case "b": case "B": return {pos: wordBackward(pos, spec.key === "B", times)};
      case "e": case "E": return {pos: wordEnd(pos, spec.key === "E", times), inclusive: true};
      case "0": return {pos: lineStart(pos)};
      case "^": return {pos: firstNonBlank(pos)};
      case "$": {
        const start = moveLines(pos, times - 1);
        const end = lineEnd(start);
        return {pos: pending ? end : Math.max(start, end - 1), endOfLine: true};
      }
      case "G": return {pos: firstNonBlank(counted ? lineStartOfNumber(times) : lineStart(source.length)), linewise: true};
      case "gg": return {pos: firstNonBlank(lineStartOfNumber(counted ? times : 1)), linewise: true};
      case "{": return {pos: paragraph(pos, false, times)};
      case "}": return {pos: paragraph(pos, true, times)};
      case "%": {
        const target = matchBracket(pos);
        return target === null ? null : {pos: target, inclusive: true};
      }
      case ";": case ",": {
        if (!lastFind) return null;
        let kind = lastFind.kind;
        if (spec.key === ",") kind = kind === kind.toLowerCase() ? kind.toUpperCase() : kind.toLowerCase();
        const target = findCharacter(kind, lastFind.character, times, pos, true);
        return target === null ? null : {pos: target, inclusive: kind === "f" || kind === "t"};
      }
      case "n": case "N": {
        if (!lastSearch) {
          message = "No previous search";
          return null;
        }
        const backward = lastSearch.backward !== (spec.key === "N");
        const target = searchFrom(lastSearch.query, pos, backward, times);
        return target === null ? null : {pos: target};
      }
    }
    return null;
  }

  function runMotion(spec) {
    const times = Math.max(1, Number(count || 1)) * Math.max(1, Number(operatorCount || 1));
    const pending = Boolean(operator);
    const result = motion(spec, times, pending);
    if (!result) return fail(message);
    if (pending) {
      if (spec.key === "w" || spec.key === "W") {
        const source = text();
        if (operator === "c" && charClass(source[cursor], spec.key === "W")) {
          result.pos = wordEnd(cursor, spec.key === "W", times);
          result.inclusive = true;
        } else if (result.pos > lineEnd(cursor) && result.pos === lineStart(result.pos)) {
          result.pos = Math.max(cursor, result.pos - 1);
        }
      }
      return operate(operator, motionRange(cursor, result), times);
    }
    cursor = result.pos;
    if (result.endOfLine) desiredColumn = Infinity;
    else if (!result.vertical) desiredColumn = column(cursor);
    resetPending();
    render();
  }

  function replaceCharacters(character, times) {
    const source = text();
    if (isVisual()) {
      const range = visualRange();
      const replacement = source.slice(range.from, range.to).replace(/[^\n]/g, character);
      mode = "normal";
      if (!change(range.from, range.to, replacement, range.from)) return fail(PROTECTED_MESSAGE);
      cursor = range.from;
      return finish({changed: true});
    }
    if (cursor + times > lineEnd(cursor)) return fail();
    if (!change(cursor, cursor + times, character.repeat(times), cursor + times - 1)) return fail(PROTECTED_MESSAGE);
    cursor += times - 1;
    finish({changed: true});
  }

  function openLine(below) {
    const source = text();
    const start = lineStart(cursor);
    const end = lineEnd(cursor);
    const indent = source.slice(start, firstNonBlank(start));
    let caret;
    let ok;
    if (below) {
      ok = changeAny(end < source.length ? [end + 1, end + 1, indent + "\n", end + 1 + indent.length] : null,
        [end, end, "\n" + indent, end + 1 + indent.length]);
      caret = editor.selectionStart;
    } else {
      ok = changeAny([start, start, indent + "\n", start + indent.length],
        start > 0 ? [start - 1, start - 1, "\n" + indent, start + indent.length] : null);
      caret = editor.selectionStart;
    }
    if (!ok) return fail(PROTECTED_MESSAGE);
    startInsert(caret);
  }

  function paste(before, times) {
    if (!register.text) return fail("Nothing to paste");
    const source = text();
    let ok;
    if (register.linewise) {
      const block = register.text.repeat(times);
      if (before) {
        const start = lineStart(cursor);
        ok = changeAny([start, start, block, start],
          start > 0 ? [start - 1, start - 1, "\n" + block.slice(0, -1), start] : null);
        if (ok) cursor = firstNonBlank(start);
      } else {
        const end = lineEnd(cursor);
        ok = changeAny(end < source.length ? [end + 1, end + 1, block, end + 1] : null,
          [end, end, "\n" + block.slice(0, -1), end + 1]);
        if (ok) cursor = firstNonBlank(end + 1);
      }
    } else {
      const block = register.text.repeat(times);
      const at = before || lineEnd(cursor) === lineStart(cursor) ? cursor : cursor + 1;
      ok = change(at, at, block, at + block.length - 1);
      if (ok) cursor = at + block.length - 1;
    }
    if (!ok) return fail(PROTECTED_MESSAGE);
    finish({changed: true});
  }

  function pasteOverSelection() {
    if (!register.text) return fail("Nothing to paste");
    const range = visualRange();
    const replaced = text().slice(range.from, range.to);
    let replacement = register.text;
    if (register.linewise) replacement = range.linewise ? replacement.slice(0, -1) : "\n" + replacement;
    mode = "normal";
    if (!change(range.from, range.to, replacement, range.from)) return fail(PROTECTED_MESSAGE);
    setRegister(range.linewise ? replaced + "\n" : replaced, range.linewise);
    cursor = range.from;
    finish({changed: true});
  }

  function joinLines(start, lines) {
    const source = text();
    let last = start;
    for (let step = 0; step < lines - 1; step++) {
      const end = lineEnd(last);
      if (end >= source.length) break;
      last = end + 1;
    }
    if (last === start) return fail();
    const end = lineEnd(last);
    const parts = source.slice(start, end).split("\n");
    let joined = parts[0];
    let caret = 0;
    parts.slice(1).forEach(part => {
      const trimmed = part.replace(/^[\t ]+/, "");
      caret = joined.length;
      const space = trimmed && joined && !/[\t ]$/.test(joined) && !trimmed.startsWith(")") ? " " : "";
      joined += space + trimmed;
    });
    mode = "normal";
    if (!change(start, end, joined, start + caret)) return fail(PROTECTED_MESSAGE);
    cursor = start + caret;
    finish({changed: true});
  }

  function changeCase(range, transform, caret) {
    const original = text().slice(range.from, range.to);
    mode = "normal";
    if (!changeMinimal(range.from, range.to, transform(original), caret)) return fail(PROTECTED_MESSAGE);
    cursor = caret;
    finish({changed: true});
  }

  const toggleCase = value => value.replace(/[a-z]/gi,
    character => character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase());

  function searchWord(backward) {
    const start = charClass(text()[cursor]) ? cursor : Math.min(wordForward(cursor, false, 1), lineEnd(cursor));
    const range = textObject("i", "w", start);
    const word = range && text().slice(range.from, range.to).trim();
    if (!word) return fail("No string under cursor");
    lastSearch = {query: word, backward};
    host.search(word);
    const target = searchFrom(word, range.from, backward, Math.max(1, Number(count || 1)));
    if (target !== null) cursor = target;
    desiredColumn = column(cursor);
    resetPending();
    render();
  }

  function scrollHalfPage(down) {
    const area = host.scrollArea();
    const line = host.lineElement(lineNumberAt(cursor));
    const lineHeight = line?.offsetHeight || 23;
    const half = Math.max(1, Math.floor((area?.clientHeight || 400) / lineHeight / 2));
    if (area) area.scrollTo({top: area.scrollTop + (down ? half : -half) * lineHeight, behavior: "instant"});
    cursor = atColumn(moveLines(cursor, down ? half : -half), desiredColumn);
    resetPending();
    render();
  }

  function repeatLastChange(times) {
    if (!lastChange) return fail();
    const repeated = lastChange;
    replaying = true;
    try {
      for (let step = 0; step < times; step++) {
        resetPending();
        repeated.keys.forEach(key => {
          commandKeys.push(key);
          process(key);
        });
        if (mode === "insert") {
          if (repeated.insertText) {
            const caret = editor.selectionStart;
            change(caret, caret, repeated.insertText, caret + repeated.insertText.length);
          }
          leaveInsert();
        }
      }
    } finally {
      replaying = false;
      resetPending();
      render();
    }
  }

  function openCommandLine(kind) {
    const input = host.commandLine;
    commandRange = isVisual() ? {first: lineNumberAt(Math.min(anchor, cursor)), last: lineNumberAt(Math.max(anchor, cursor))} : null;
    input.hidden = false;
    input.value = kind + (kind === ":" && commandRange ? "'<,'>" : "");
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    resetPending();
    updateStatus();
  }

  function closeCommandLine() {
    host.commandLine.hidden = true;
    host.commandLine.value = "";
    editor.focus();
    render();
  }

  function parseLineRange(value) {
    const current = lineNumberAt(cursor);
    const address = token => token === "." ? current : token === "$" ? lineCount() : Number(token);
    if (value.startsWith("%")) return {first: 1, last: lineCount(), rest: value.slice(1)};
    if (value.startsWith("'<,'>")) {
      const range = commandRange || {first: current, last: current};
      return {...range, rest: value.slice(5)};
    }
    const match = value.match(/^(\d+|\.|\$)(?:,(\d+|\.|\$))?/);
    if (!match) return {first: current, last: current, rest: value, implicit: true};
    const first = address(match[1]);
    const last = match[2] ? address(match[2]) : first;
    return {first: Math.min(first, last), last: Math.max(first, last), rest: value.slice(match[0].length)};
  }

  function splitPattern(value, delimiter) {
    const parts = [""];
    for (let index = 0; index < value.length; index++) {
      if (value[index] === "\\" && value[index + 1] === delimiter) {
        parts[parts.length - 1] += delimiter;
        index++;
      } else if (value[index] === delimiter) parts.push("");
      else parts[parts.length - 1] += value[index];
    }
    return parts;
  }

  function substitute(range, command) {
    const delimiter = command[1];
    if (!delimiter || /[\w\s]/.test(delimiter)) return `Invalid substitute: ${command}`;
    const [pattern, replacement = "", flags = ""] = splitPattern(command.slice(2), delimiter);
    const query = pattern || lastSearch?.query;
    if (!query) return "No previous pattern";
    let expression;
    try {
      expression = new RegExp(query, (flags.includes("g") ? "g" : "") + (flags.includes("i") ? "i" : ""));
    } catch (error) {
      return `Invalid pattern: ${error.message}`;
    }
    const jsReplacement = replacement
      .replace(/\$/g, "$$$$")
      .replace(/\\(\d)/g, "$$$1")
      .replace(/(^|[^\\])&/g, "$1$$&")
      .replace(/\\&/g, "&")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t");
    const from = lineStartOfNumber(range.first);
    const to = lineEnd(lineStartOfNumber(range.last));
    let substitutions = 0;
    let changedLines = 0;
    const lines = text().slice(from, to).split("\n").map(line => {
      let hits = 0;
      const updated = line.replace(expression, match => {
        hits++;
        return match.replace(new RegExp(expression.source, expression.flags.replace("g", "")), jsReplacement);
      });
      substitutions += hits;
      if (hits) changedLines++;
      return updated;
    });
    if (!substitutions) return `Pattern not found: ${query}`;
    const block = lines.join("\n");
    if (!changeMinimal(from, to, block, from)) return PROTECTED_MESSAGE;
    cursor = firstNonBlank(from);
    lastChange = null;
    return substitutions > 1 ? `${substitutions} substitutions on ${changedLines} line${changedLines === 1 ? "" : "s"}` : "";
  }

  function runCommand(value) {
    const kind = value[0];
    const body = value.slice(1);
    if (kind === "/" || kind === "?") {
      const query = body || lastSearch?.query;
      if (!query) return;
      lastSearch = {query, backward: kind === "?"};
      host.search(query);
      const target = searchFrom(query, cursor, lastSearch.backward, 1);
      if (target !== null) {
        cursor = target;
        desiredColumn = column(cursor);
      }
      return;
    }
    if (isVisual()) mode = "normal";
    const range = parseLineRange(body.trim());
    const command = range.rest.trim();
    if (!command) {
      if (!range.implicit) cursor = firstNonBlank(lineStartOfNumber(Math.min(range.last, lineCount())));
      return;
    }
    if (/^(w|write|up|update|wq|x|xit|wa|wall)!?$/.test(command)) {
      host.save();
      return;
    }
    if (/^(q|quit|qa|qall)!?$/.test(command)) {
      message = "Close the ASE Studio window to quit";
      return;
    }
    if (/^noh(lsearch)?$/.test(command)) {
      host.search("");
      return;
    }
    if (/^s(ubstitute)?\W/.test(command)) {
      message = substitute(range, command.replace(/^substitute/, "s"));
      return;
    }
    message = `Not an editor command: ${command}`;
  }

  function process(key) {
    const visual = isVisual();
    if (key === "Escape" || key === "ctrl-[" || key === "ctrl-c") {
      if (visual && !operator && !prefix && !count) mode = "normal";
      return fail();
    }
    if (prefix === "r" || prefix === "f" || prefix === "F" || prefix === "t" || prefix === "T") {
      const kind = prefix;
      prefix = "";
      if (key.length !== 1) return fail();
      if (kind === "r") return replaceCharacters(key, Math.max(1, Number(count || 1)));
      lastFind = {kind, character: key};
      return runMotion({find: kind, character: key});
    }
    if (prefix === "g") {
      prefix = "";
      if (key === "g") return runMotion({key: "gg"});
      if (key === "J" || key === "~" || key === "u" || key === "U") return fail(`g${key} is not supported`);
      return fail();
    }
    if (prefix === "i" || prefix === "a") {
      const kind = prefix;
      prefix = "";
      const range = textObject(kind, key, cursor);
      if (!range || range.to <= range.from) return fail();
      if (operator) return operate(operator, {...range, linewise: false});
      mode = "visual";
      anchor = range.from;
      cursor = range.to - 1;
      resetPending();
      return render();
    }
    key = ALIASES[key] || key;
    const times = Math.max(1, Number(count || 1));

    if (/^[1-9]$/.test(key) || (key === "0" && count)) {
      count += key;
      return updateStatus();
    }
    if (MOTIONS.has(key)) return runMotion({key});
    if ("fFtT".includes(key) && key.length === 1) {
      prefix = key;
      return updateStatus();
    }
    if (key === "g") {
      prefix = "g";
      return updateStatus();
    }
    if (OPERATORS.has(key)) {
      if (visual) {
        const range = visualRange();
        mode = "normal";
        return operate(key, range, key === ">" || key === "<" ? times : 1);
      }
      if (operator === key) {
        const total = times * Math.max(1, Number(operatorCount || 1));
        const end = moveLines(cursor, total - 1);
        return operate(key, {from: lineStart(cursor), to: lineEnd(end), linewise: true});
      }
      if (operator) return fail();
      operator = key;
      operatorCount = count;
      count = "";
      return updateStatus();
    }
    if (operator) {
      if (key === "i" || key === "a") {
        prefix = key;
        return updateStatus();
      }
      return fail();
    }
    if (visual) return processVisual(key, times);
    return processNormal(key, times);
  }

  function processVisual(key, times) {
    const range = visualRange();
    switch (key) {
      case "v": case "V": {
        const wanted = key === "v" ? "visual" : "visual-line";
        mode = mode === wanted ? "normal" : wanted;
        resetPending();
        return render();
      }
      case "o": [anchor, cursor] = [cursor, anchor]; resetPending(); return render();
      case "x": case "X": case "D": mode = "normal"; return operate("d", key === "x" ? range : {...range, from: lineStart(range.from), to: lineEnd(range.to), linewise: true});
      case "s": case "S": case "C": case "R": mode = "normal"; return operate("c", key === "s" ? range : {...range, from: lineStart(range.from), to: lineEnd(range.to), linewise: true});
      case "Y": mode = "normal"; return operate("y", {...range, from: lineStart(range.from), to: lineEnd(range.to), linewise: true});
      case "J": return joinLines(lineStart(range.from), Math.max(2, lineNumberAt(range.to) - lineNumberAt(range.from) + 1));
      case "~": return changeCase(range, toggleCase, range.from);
      case "u": return changeCase(range, value => value.toLowerCase(), range.from);
      case "U": return changeCase(range, value => value.toUpperCase(), range.from);
      case "r": prefix = "r"; return updateStatus();
      case "p": case "P": return pasteOverSelection();
      case "i": case "a": prefix = key; return updateStatus();
      case ":": return openCommandLine(":");
      case "/": case "?": return openCommandLine(key);
      case "*": case "#": mode = "normal"; return searchWord(key === "#");
      case "ctrl-d": case "ctrl-u": return scrollHalfPage(key === "ctrl-d");
    }
    return fail();
  }

  function processNormal(key, times) {
    const empty = lineEnd(cursor) === lineStart(cursor);
    switch (key) {
      case "i": return startInsert(cursor);
      case "a": return startInsert(empty ? cursor : cursor + 1);
      case "I": return startInsert(firstNonBlank(cursor));
      case "A": return startInsert(lineEnd(cursor));
      case "o": return openLine(true);
      case "O": return openLine(false);
      case "x":
        if (empty) return fail();
        return operate("d", {from: cursor, to: Math.min(lineEnd(cursor), cursor + times), linewise: false});
      case "X":
        if (cursor === lineStart(cursor)) return fail();
        return operate("d", {from: Math.max(lineStart(cursor), cursor - times), to: cursor, linewise: false});
      case "s":
        if (empty) return startInsert(cursor);
        return operate("c", {from: cursor, to: Math.min(lineEnd(cursor), cursor + times), linewise: false});
      case "S": return operate("c", {from: lineStart(cursor), to: lineEnd(moveLines(cursor, times - 1)), linewise: true});
      case "D": return operate("d", {from: cursor, to: lineEnd(moveLines(cursor, times - 1)), linewise: false});
      case "C": return operate("c", {from: cursor, to: lineEnd(moveLines(cursor, times - 1)), linewise: false});
      case "Y": return operate("y", {from: lineStart(cursor), to: lineEnd(moveLines(cursor, times - 1)), linewise: true});
      case "p": return paste(false, times);
      case "P": return paste(true, times);
      case "r": prefix = "r"; return updateStatus();
      case "J": return joinLines(lineStart(cursor), Math.max(2, times));
      case "~": {
        if (empty) return fail();
        const to = Math.min(lineEnd(cursor), cursor + times);
        return changeCase({from: cursor, to}, toggleCase, clampNormal(to));
      }
      case "u":
        host.undo();
        cursor = clampNormal(editor.selectionStart);
        resetPending();
        return render();
      case "ctrl-r":
        host.redo();
        cursor = clampNormal(editor.selectionStart);
        resetPending();
        return render();
      case ".": return repeatLastChange(times);
      case "v": case "V":
        mode = key === "v" ? "visual" : "visual-line";
        anchor = cursor;
        resetPending();
        return render();
      case ":": case "/": case "?": return openCommandLine(key);
      case "*": case "#": return searchWord(key === "#");
      case "ctrl-d": case "ctrl-u": return scrollHalfPage(key === "ctrl-d");
    }
    return fail();
  }

  function revealCursor() {
    const area = host.scrollArea();
    const line = host.lineElement(lineNumberAt(mode === "insert" ? editor.selectionStart : cursor));
    if (!area || !line) return;
    const margin = line.offsetHeight * 2;
    const top = line.offsetTop;
    const bottom = top + line.offsetHeight;
    let target = null;
    if (top - margin < area.scrollTop) target = Math.max(0, top - margin);
    else if (bottom + margin > area.scrollTop + area.clientHeight) target = bottom + margin - area.clientHeight;
    if (target !== null) area.scrollTo({top: target, behavior: "instant"});
  }

  function updateStatus() {
    host.bar.hidden = !enabled;
    if (!enabled) return;
    const commandOpen = !host.commandLine.hidden;
    host.status.hidden = commandOpen;
    host.status.dataset.mode = mode;
    host.status.textContent = `-- ${MODE_LABELS[mode]} --`;
    host.message.textContent = message;
    host.message.hidden = commandOpen || !message;
    host.pending.textContent = count || operator || prefix ? `${operatorCount}${operator || ""}${count}${prefix}` : "";
  }

  function render() {
    editor.classList.toggle("vim-block", enabled && mode === "normal");
    if (enabled && mode !== "insert") {
      const length = text().length;
      if (mode === "normal") {
        cursor = clampNormal(cursor);
        editor.setSelectionRange(cursor, Math.min(length, cursor + 1));
      } else {
        cursor = Math.max(0, Math.min(cursor, length));
        const range = visualRange();
        const to = range.linewise && range.to < length ? range.to + 1 : Math.max(range.to, Math.min(length, range.from + 1));
        editor.setSelectionRange(range.from, to, cursor < anchor ? "backward" : "forward");
      }
    }
    rendered = {start: editor.selectionStart, end: editor.selectionEnd};
    updateStatus();
    if (document.activeElement === editor) revealCursor();
  }

  function syncFromEditor() {
    if (editor.selectionStart === rendered.start && editor.selectionEnd === rendered.end) return;
    if (isVisual()) mode = "normal";
    cursor = clampNormal(editor.selectionStart);
    desiredColumn = column(cursor);
  }

  function keyName(event) {
    if (event.metaKey) return null;
    if (event.ctrlKey && !event.altKey) {
      return "ctrl-" + (event.key.length === 1 ? event.key.toLowerCase() : event.key);
    }
    return event.key;
  }

  function handleKeydown(event) {
    if (!enabled || event.isComposing || event.key === "Dead" || !host.isActive()) return false;
    const key = keyName(event);
    if (mode === "insert") {
      if (key !== "Escape" && key !== "ctrl-[" && key !== "ctrl-c") return false;
      event.preventDefault();
      message = "";
      leaveInsert();
      return true;
    }
    if (key === null) return false;
    if (["Shift", "Control", "Alt", "Meta", "CapsLock", "Tab"].includes(event.key)) return event.key !== "Tab";
    if (key.startsWith("ctrl-") && !["ctrl-r", "ctrl-d", "ctrl-u", "ctrl-[", "ctrl-c"].includes(key)) return false;
    event.preventDefault();
    syncFromEditor();
    message = "";
    commandKeys.push(key);
    process(key);
    return true;
  }

  editor.addEventListener("mouseup", () => {
    if (!enabled || mode === "insert") return;
    const {selectionStart, selectionEnd} = editor;
    resetPending();
    if (selectionEnd - selectionStart > 1) {
      mode = "visual";
      anchor = selectionStart;
      cursor = selectionEnd - 1;
    } else {
      mode = "normal";
      cursor = selectionStart;
      desiredColumn = column(clampNormal(cursor));
    }
    render();
  });
  editor.addEventListener("input", () => {
    if (!enabled || mode === "insert") return;
    cursor = editor.selectionStart;
    render();
  });
  host.commandLine.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      const value = host.commandLine.value;
      closeCommandLine();
      if (value.length > 1 || value === "/" || value === "?") runCommand(value);
      render();
    } else if (event.key === "Escape" || (event.key === "Backspace" && host.commandLine.value.length <= 1)) {
      event.preventDefault();
      closeCommandLine();
    }
  });
  host.commandLine.addEventListener("blur", () => {
    if (!host.commandLine.hidden) {
      host.commandLine.hidden = true;
      host.commandLine.value = "";
      updateStatus();
    }
  });

  function setEnabled(value) {
    enabled = Boolean(value);
    resetPending();
    message = "";
    insertOrigin = null;
    if (enabled) {
      mode = "normal";
      cursor = clampNormal(editor.selectionStart);
      desiredColumn = column(cursor);
      render();
      return;
    }
    editor.classList.remove("vim-block");
    host.commandLine.hidden = true;
    host.message.hidden = true;
    const caret = editor.selectionStart;
    editor.setSelectionRange(caret, caret);
    updateStatus();
  }

  return {handleKeydown, setEnabled, isEnabled: () => enabled};
}
