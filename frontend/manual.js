/*
 * SPDX-License-Identifier: GPL-2.0-only
 */
// RISC-V manual tab: searchable reference built from RISCV_MANUAL. The host
// supplies the syntax highlighter and access to the CPU configuration so each
// entry can show how this project's simulator will time it.
function createManual(host) {
  const FILTERS = [
    {id: "all", label: "All"},
    {id: "RV32I", label: "RV32I", extensions: ["RV32I"]},
    {id: "M", label: "M", extensions: ["M"]},
    {id: "A", label: "A", extensions: ["A"]},
    {id: "F", label: "F", extensions: ["F"]},
    {id: "D", label: "D", extensions: ["D"]},
    {id: "system", label: "CSR & system", extensions: ["Zicsr", "Zifencei", "Privileged"]},
    {id: "Pseudo", label: "Pseudo", extensions: ["Pseudo"]},
    {id: "C", label: "Compressed", extensions: ["C"]},
    {id: "Directive", label: "Directives", extensions: ["Directive"]}
  ];
  // Spellings the assembler accepts for the same directive.
  const DIRECTIVE_SYNONYMS = {".global": ".globl", ".short": ".half", ".string": ".asciz",
    ".zero": ".space", ".set": ".equ", ".p2align": ".align"};
  const UNITS = {
    "integer-alu": {label: "Integer ALU", latency: "intAlu", pipelined: "intAluPipelined"},
    "integer-multiply": {label: "Integer multiply", latency: "intMul", pipelined: "intMulPipelined"},
    "integer-divide": {label: "Integer divide", latency: "intDiv", pipelined: "intDivPipelined"},
    "float-alu": {label: "Floating-point ALU", latency: "floatAlu", pipelined: "floatAluPipelined"},
    "float-multiply": {label: "Floating-point multiply", latency: "floatMul", pipelined: "floatMulPipelined"},
    "float-divide": {label: "Floating-point divide", latency: "floatDiv", pipelined: "floatDivPipelined"}
  };
  // Bit layout of each 32-bit format, most significant field first.
  const FORMATS = {
    "R": [["funct7", 31, 25], ["rs2", 24, 20], ["rs1", 19, 15], ["funct3", 14, 12], ["rd", 11, 7], ["opcode", 6, 0]],
    "R4": [["rs3", 31, 27], ["fmt", 26, 25], ["rs2", 24, 20], ["rs1", 19, 15], ["funct3", 14, 12], ["rd", 11, 7], ["opcode", 6, 0]],
    "R-atomic": [["funct5", 31, 27], ["aq", 26, 26], ["rl", 25, 25], ["rs2", 24, 20], ["rs1", 19, 15], ["funct3", 14, 12], ["rd", 11, 7], ["opcode", 6, 0]],
    "I": [["imm", 31, 20, "imm[11:0]"], ["rs1", 19, 15], ["funct3", 14, 12], ["rd", 11, 7], ["opcode", 6, 0]],
    "I-shamt": [["funct7", 31, 25], ["shamt", 24, 20], ["rs1", 19, 15], ["funct3", 14, 12], ["rd", 11, 7], ["opcode", 6, 0]],
    "I-csr": [["csr", 31, 20], ["rs1", 19, 15], ["funct3", 14, 12], ["rd", 11, 7], ["opcode", 6, 0]],
    "I-fence": [["imm", 31, 20, "fm · pred · succ"], ["rs1", 19, 15], ["funct3", 14, 12], ["rd", 11, 7], ["opcode", 6, 0]],
    "S": [["imm", 31, 25, "imm[11:5]"], ["rs2", 24, 20], ["rs1", 19, 15], ["funct3", 14, 12], ["imm", 11, 7, "imm[4:0]"], ["opcode", 6, 0]],
    "B": [["imm", 31, 25, "imm[12|10:5]"], ["rs2", 24, 20], ["rs1", 19, 15], ["funct3", 14, 12], ["imm", 11, 7, "imm[4:1|11]"], ["opcode", 6, 0]],
    "U": [["imm", 31, 12, "imm[31:12]"], ["rd", 11, 7], ["opcode", 6, 0]],
    "J": [["imm", 31, 12, "imm[20|10:1|11|19:12]"], ["rd", 11, 7], ["opcode", 6, 0]]
  };
  const FORMAT_NAMES = {"R": "R-type", "R4": "R4-type", "R-atomic": "R-type (atomic)", "I": "I-type",
    "I-shamt": "I-type (shift)", "I-csr": "I-type (CSR)", "I-fence": "I-type (fence)", "S": "S-type",
    "B": "B-type", "U": "U-type", "J": "J-type"};

  const entries = RISCV_MANUAL;
  const byMnemonic = new Map(entries.map(entry => [entry.mnemonic, entry]));
  const searchText = new Map(entries.map(entry => [entry, [entry.mnemonic, entry.name, entry.syntax,
    entry.description, entry.extension, entry.expansion || ""].join(" ").toLowerCase()]));
  const pane = host.pane;
  const search = pane.querySelector("#manual-search");
  const filterBar = pane.querySelector("#manual-filters");
  const list = pane.querySelector("#manual-list");
  const detail = pane.querySelector("#manual-detail");
  const count = pane.querySelector("#manual-count");

  let filter = localStorage.getItem("ase-studio-manual-filter") || "all";
  if (!FILTERS.some(item => item.id === filter)) filter = "all";
  let results = [];
  let selected = null;
  let config = null;

  const escape = host.escapeHtml;
  const code = text => text.split("\n").map(line => host.highlight(line) || "&nbsp;").join("\n");

  function lookupKey(word) {
    let key = String(word || "").trim().toLowerCase();
    key = DIRECTIVE_SYNONYMS[key] || key;
    if (!byMnemonic.has(key)) key = key.replace(/\.(?:aqrl|aq|rl)$/, "");
    return key;
  }

  function score(entry, query, terms) {
    const mnemonic = entry.mnemonic;
    if (mnemonic === query) return 1000;
    if (mnemonic.startsWith(query)) return 800 - mnemonic.length;
    // One or two letters are almost always the start of a mnemonic; matching
    // them inside descriptions would only add noise.
    if (query.length < 3) return mnemonic.includes(query) ? 600 : 0;
    const text = searchText.get(entry);
    if (!terms.every(term => text.includes(term))) return 0;
    if (mnemonic.includes(query)) return 600;
    const name = entry.name.toLowerCase();
    if (terms.every(term => name.includes(term))) return 400;
    return 100;
  }

  function filterResults() {
    const query = search.value.trim().toLowerCase();
    const extensions = FILTERS.find(item => item.id === filter).extensions;
    const pool = extensions ? entries.filter(entry => extensions.includes(entry.extension)) : entries;
    if (!query) return pool;
    const terms = query.split(/\s+/);
    return pool.map((entry, index) => ({entry, index, score: score(entry, query, terms)}))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map(item => item.entry);
  }

  function renderFilters() {
    filterBar.innerHTML = FILTERS.map(item =>
      `<button type="button" class="manual-filter${item.id === filter ? " selected" : ""}" data-filter="${item.id}">${item.label}</button>`
    ).join("");
  }

  function renderList() {
    results = filterResults();
    if (!results.includes(selected)) selected = results[0] || null;
    count.textContent = `${results.length} ${results.length === 1 ? "entry" : "entries"}`;
    list.innerHTML = results.length ? results.map(entry => `
      <button type="button" class="manual-item${entry === selected ? " selected" : ""}" data-mnemonic="${escape(entry.mnemonic)}">
        <code>${escape(entry.mnemonic)}</code><span>${escape(entry.name)}</span><small>${escape(entry.extension)}</small>
      </button>`).join("")
      : '<div class="manual-empty">No instruction matches this search.</div>';
    renderDetail();
  }

  function mnemonicLinks(text) {
    // Turn base mnemonics at the start of each expansion line into links.
    return text.split("\n").map(line => {
      if (line.startsWith("#")) return `<span class="comment">${escape(line)}</span>`;
      const match = line.match(/^(\S+)(.*)$/);
      if (!match || !byMnemonic.has(match[1])) return host.highlight(line);
      return `<a href="#" class="manual-link" data-mnemonic="${escape(match[1])}">${escape(match[1])}</a>${host.highlight(match[2])}`;
    }).join("\n");
  }

  function encodingDiagram(encoding) {
    if (encoding.compressed) {
      return `<p class="manual-note">16-bit ${escape(encoding.format)} format. Each compressed instruction is decoded to the 32-bit instruction shown above, so it behaves exactly like it.</p>`;
    }
    const fields = FORMATS[encoding.format].map(([key, high, low, label = key]) => {
      let value = encoding[key];
      if (key === "rs1" && encoding.format === "I-csr" && encoding.funct3.startsWith("1")) label = "uimm";
      if (value === "rm") { label = "rm"; value = null; }
      const width = high - low + 1;
      const bits = high === low ? `${high}` : `${high}<span>${low}</span>`;
      return `<div class="encoding-field${value ? " fixed" : ""}" style="flex-grow:${width}">
        <div class="encoding-bits">${bits}</div>
        <div class="encoding-value">${value ? escape(value) : escape(label)}</div>
        <div class="encoding-name">${value ? escape(label) : "&nbsp;"}</div>
      </div>`;
    }).join("");
    return `<div class="encoding" aria-label="${escape(FORMAT_NAMES[encoding.format])} encoding">${fields}</div>
      <p class="manual-note">${escape(FORMAT_NAMES[encoding.format])}. Shaded fields have fixed bits; the others hold the operands.</p>`;
  }

  // Mirrors how backend.py assigns pipeline units, so the latency shown here
  // matches what the Pipeline tab will display.
  function timingClass(opcode) {
    if (/^(?:l(?:b|bu|h|hu|w|wu|d)|fl[wdq])$/.test(opcode)) return "load";
    if (/^(?:s[bhwdq]|fs[wdq])$/.test(opcode)) return "store";
    if (/^fmul/.test(opcode)) return "float-multiply";
    if (/^fdiv/.test(opcode)) return "float-divide";
    if (/^f/.test(opcode)) return "float-alu";
    if (/^mul/.test(opcode)) return "integer-multiply";
    if (/^(?:div|rem)/.test(opcode)) return "integer-divide";
    return "integer-alu";
  }

  function unitText(unitKey) {
    const unit = UNITS[unitKey];
    const latency = config[unit.latency];
    return `<strong>${unit.label}</strong> · ${latency} ${latency === 1 ? "cycle" : "cycles"}, ${config[unit.pipelined] ? "pipelined" : "not pipelined"}`;
  }

  function memoryText(kind) {
    if (config.memoryMode === "cache") {
      return `<strong>L1 data cache</strong> · hit ${config.cacheLatency} cycles, main memory ${config.memoryLatency} cycles on a miss`;
    }
    const latency = kind === "load" ? config.dataReadLatency : config.dataWriteLatency;
    return `<strong>Data ${kind === "load" ? "read" : "write"}</strong> · ${latency} ${latency === 1 ? "cycle" : "cycles"} (direct memory)`;
  }

  function timingRows(opcode) {
    const kind = timingClass(opcode);
    if (kind !== "load" && kind !== "store") return [unitText(kind)];
    const address = config.cpu === "out-of-order"
      ? "<strong>Address unit</strong> · 1 cycle"
      : `${unitText("integer-alu")} (address calculation)`;
    return [address, memoryText(kind)];
  }

  function projectSection(entry) {
    if (entry.extension === "Directive") return "";
    if (!config) {
      return `<section><h4>In this project</h4><p class="manual-note">Open a project to see how its CPU configuration times this instruction.</p></section>`;
    }
    const notes = [];
    if ((entry.extension === "D" || entry.needsDouble) && config.floatingPointPrecision !== "double") {
      notes.push('<p class="manual-warning">Not available with the current configuration: set the floating-point <strong>Precision</strong> to <strong>Double (64-bit)</strong> in CPU Configuration, or the assembler will reject it.</p>');
    }
    if (entry.extension === "C" && !config.compressedInstructions) {
      notes.push('<p class="manual-warning">Not available with the current configuration: turn on <strong>Enable compressed instructions (RVC)</strong> in CPU Configuration.</p>');
    }
    let timing = "";
    if (!entry.system) {
      const opcodes = entry.expansion
        ? [...new Set(entry.expansion.split("\n").filter(line => line && !line.startsWith("#"))
          .map(line => line.trim().split(/\s+/)[0]))]
        : [entry.mnemonic];
      if (opcodes.length === 1) {
        timing = `<ul class="manual-timing">${timingRows(opcodes[0]).map(row => `<li>${row}</li>`).join("")}</ul>`;
      } else {
        timing = `<ul class="manual-timing">${opcodes.map(opcode =>
          `<li><code>${escape(opcode)}</code> → ${timingRows(opcode).join(", then ")}</li>`).join("")}</ul>`;
      }
    }
    const model = config.cpu === "out-of-order" ? "multiple-issue processor" : "five-stage pipeline";
    return `<section><h4>In this project</h4>${notes.join("")}${timing}
      <p class="manual-note">From this project's CPU configuration (${model}${config.forwarding ? ", forwarding on" : ", forwarding off"}).
      <a href="#" class="manual-configure">Change…</a></p></section>`;
  }

  function renderDetail() {
    list.querySelectorAll(".manual-item").forEach(item =>
      item.classList.toggle("selected", item.dataset.mnemonic === selected?.mnemonic));
    if (!selected) {
      detail.innerHTML = '<div class="manual-empty">Search for an instruction by name or by what it does, for example “shift”, “unsigned” or “load”.</div>';
      return;
    }
    const entry = selected;
    const sections = [];
    if (entry.operation) sections.push(`<section><h4>Operation</h4><pre class="manual-code">${escape(entry.operation)}</pre></section>`);
    if (entry.expansion) sections.push(`<section><h4>${entry.extension === "C" ? "Equivalent to" : "Expands to"}</h4><pre class="manual-code">${mnemonicLinks(entry.expansion)}</pre></section>`);
    if (entry.example) sections.push(`<section><h4>Example</h4><pre class="manual-code">${code(entry.example)}</pre></section>`);
    if (entry.encoding) sections.push(`<section><h4>Encoding</h4>${encodingDiagram(entry.encoding)}</section>`);
    sections.push(projectSection(entry));
    if (entry.see?.length) {
      sections.push(`<section><h4>See also</h4><p class="manual-see">${entry.see.map(mnemonic =>
        `<a href="#" class="manual-link" data-mnemonic="${escape(mnemonic)}">${escape(mnemonic)}</a>`).join("")}</p></section>`);
    }
    detail.innerHTML = `
      <div class="manual-heading"><h3>${escape(entry.mnemonic)}</h3><span class="manual-badge">${escape(entry.extension)}</span><span class="manual-name">${escape(entry.name)}</span></div>
      <pre class="manual-code manual-syntax">${code(entry.syntax)}</pre>
      <p class="manual-description">${escape(entry.description).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>
      ${sections.join("")}`;
    detail.scrollTop = 0;
  }

  function select(entry, {reveal = true} = {}) {
    selected = entry;
    renderDetail();
    if (!reveal) return;
    list.querySelector(".manual-item.selected")?.scrollIntoView({block: "nearest"});
  }

  function moveSelection(delta) {
    if (!results.length) return;
    const index = Math.max(0, Math.min(results.length - 1, results.indexOf(selected) + delta));
    select(results[index]);
  }

  function setFilter(id) {
    filter = id;
    selected = null;
    localStorage.setItem("ase-studio-manual-filter", id);
    renderFilters();
    renderList();
  }

  // Shows an entry by mnemonic. Returns false (and runs the word as a search)
  // when the manual has no such entry.
  function open(word) {
    const key = lookupKey(word);
    const entry = byMnemonic.get(key);
    if (filter !== "all" && !(entry && FILTERS.find(item => item.id === filter).extensions.includes(entry.extension))) {
      filter = "all";
      renderFilters();
    }
    search.value = entry ? entry.mnemonic : String(word || "").trim();
    renderList();
    if (entry) select(entry);
    return Boolean(entry);
  }

  search.addEventListener("input", () => {
    selected = null;
    renderList();
    list.scrollTop = 0;
  });
  search.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Escape" && search.value) {
      event.preventDefault();
      search.value = "";
      selected = null;
      renderList();
    }
  });
  filterBar.addEventListener("click", event => {
    const button = event.target.closest("[data-filter]");
    if (button) setFilter(button.dataset.filter);
  });
  list.addEventListener("click", event => {
    const item = event.target.closest("[data-mnemonic]");
    if (item) select(byMnemonic.get(item.dataset.mnemonic), {reveal: false});
  });
  list.addEventListener("keydown", event => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    moveSelection(event.key === "ArrowDown" ? 1 : -1);
    list.querySelector(".manual-item.selected")?.focus();
  });
  detail.addEventListener("click", event => {
    const link = event.target.closest(".manual-link");
    if (link) {
      event.preventDefault();
      open(link.dataset.mnemonic);
      return;
    }
    if (event.target.closest(".manual-configure")) {
      event.preventDefault();
      host.openCpuConfiguration();
    }
  });

  renderFilters();
  renderList();

  return {
    open,
    has: word => byMnemonic.has(lookupKey(word)),
    mnemonics: () => entries.map(entry => entry.mnemonic),
    focusSearch() {
      search.focus();
      search.select();
    },
    setConfig(value) {
      config = value;
      renderDetail();
    }
  };
}
