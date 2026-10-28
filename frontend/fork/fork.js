// Fork-only frontend additions, loaded after studio.js (see FORK.md).
//
// studio.js is a classic script, so its top-level functions and `let`
// variables are shared globals. This file wraps those functions by
// reassigning them; upstream code looks them up when it calls them, so the
// wrappers apply everywhere. Handlers that studio.js bound to a function
// directly (`onclick = runStep`) are rebound below. The fork's own names
// stay inside this function so they can never clash with upstream's.
(() => {
  // --- Markup --------------------------------------------------------------

  const projectsHeading = document.querySelector(".project-panel-header h2");
  projectsHeading.insertAdjacentHTML("beforebegin",
    '<div class="projects-heading"></div>');
  const headingRow = document.querySelector(".projects-heading");
  headingRow.append(projectsHeading);
  headingRow.insertAdjacentHTML("beforeend",
    '<button id="new-folder" title="Create a folder to group projects">+ Folder</button>');

  document.querySelector(".editor-tools").insertAdjacentHTML("afterbegin",
    '<label class="vim-toggle" title="Use Vim keybindings in the editor"><input id="vim-mode" type="checkbox"> Vim</label>');
  document.querySelector(".editor-area").insertAdjacentHTML("afterend",
    '<div id="vim-bar" hidden><span id="vim-status"></span><span id="vim-message" hidden></span>'
    + '<input id="vim-command" hidden spellcheck="false" autocomplete="off" aria-label="Vim command line">'
    + '<span id="vim-pending"></span></div>');

  document.querySelector("#bottom nav").insertAdjacentHTML("beforeend",
    '<button data-tab="manual" title="RISC-V instruction reference (F1)">Manual</button>');
  $("#bottom").insertAdjacentHTML("beforeend", `<div id="manual" hidden>
    <div class="manual-controls">
      <input id="manual-search" type="search" placeholder="Search instructions, e.g. lw, shift, unsigned" spellcheck="false" autocomplete="off" aria-label="Search the RISC-V manual">
      <div id="manual-filters" class="manual-filters"></div>
      <span id="manual-count"></span>
      <small class="manual-hint">Ctrl/⌘-click an instruction in the editor or pipeline, or press F1, to look it up.</small>
    </div>
    <div class="manual-workspace"><div id="manual-list" aria-label="Instructions"></div><article id="manual-detail" aria-live="polite"></article></div>
  </div>`);
  $('#bottom nav button[data-tab="manual"]').onclick = () => showTab("manual");

  $("#cycle-prev").title = "Previous cycle (←)";
  $("#cycle-next").title = "Next cycle (→)";

  // --- Project folders -----------------------------------------------------

  // Folders only group the sidebar; projects stay flat in the programs folder.
  const COLLAPSED_FOLDERS_KEY = "ase-studio-collapsed-folders";
  const PROJECT_DRAG_TYPE = "application/x-ase-project";
  let projectFolders = [];

  function collapsedProjectFolders() {
    try {
      const saved = JSON.parse(localStorage.getItem(COLLAPSED_FOLDERS_KEY) || "[]");
      return new Set(Array.isArray(saved) ? saved : []);
    } catch (_error) {
      return new Set();
    }
  }

  function setProjectFolderCollapsed(name, collapsed) {
    const folders = collapsedProjectFolders();
    if (collapsed) folders.add(name);
    else folders.delete(name);
    try {
      localStorage.setItem(COLLAPSED_FOLDERS_KEY, JSON.stringify([...folders]));
    } catch (_error) {
      // Collapsing still works for this session.
    }
  }

  loadProjects = async function loadProjectsInFolders() {
    const [data, saved] = await Promise.all([
      api("/api/projects"),
      api("/api/folders").catch(() => ({folders: []}))
    ]);
    const heading = document.querySelector(".project-panel-header h2");
    if (heading) heading.title = `Programs folder: ${data.directory || "unknown"}`;
    projectFolders = saved.folders || [];
    const collapsed = collapsedProjectFolders();
    const grouped = new Set(projectFolders.flatMap(folder => folder.projects));
    const projectButton = name =>
      `<button class="project ${name === current?.name ? "selected" : ""}" data-name="${escapeHtml(name)}" draggable="true">${escapeHtml(name)}</button>`;
    const folders = projectFolders.map((folder, index) => {
      const isCollapsed = collapsed.has(folder.name);
      const items = folder.projects.map(projectButton).join("")
        || '<div class="project-folder-empty">Drag projects here</div>';
      return `<div class="project-folder${isCollapsed ? " collapsed" : ""}" data-folder-drop="${index}">`
        + `<div class="project-folder-header"><button class="project-folder-toggle" data-folder-toggle="${index}" aria-expanded="${!isCollapsed}"><span class="project-folder-chevron">▾</span><span class="project-folder-name">${escapeHtml(folder.name)}</span><span class="project-folder-count">${folder.projects.length}</span></button>`
        + `<button class="project-folder-action" data-folder-rename="${index}" title="Rename folder" aria-label="Rename folder ${escapeHtml(folder.name)}">✎</button>`
        + `<button class="project-folder-action" data-folder-delete="${index}" title="Delete folder (its projects are kept)" aria-label="Delete folder ${escapeHtml(folder.name)}">×</button></div>`
        + `<div class="project-folder-items">${items}</div></div>`;
    }).join("");
    const loose = data.projects.filter(name => !grouped.has(name)).map(projectButton).join("");
    $("#projects").innerHTML = folders + loose;
  };

  async function saveProjectFolders(folders, title) {
    try {
      await api("/api/folders", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({folders})
      });
    } catch (error) {
      await showActionMessage(title, error.message);
    }
    await loadProjects();
  }

  function copyProjectFolders() {
    return projectFolders.map(folder => ({name: folder.name, projects: [...folder.projects]}));
  }

  async function createProjectFolder() {
    const name = await actionDialog({
      title: "New folder",
      message: "Group projects in the sidebar. Drag projects into the folder to move them.",
      inputLabel: "Folder name",
      confirmLabel: "Create",
      cancelLabel: "Cancel"
    });
    if (!name) return;
    await saveProjectFolders([...copyProjectFolders(), {name, projects: []}], "New folder");
  }

  async function renameProjectFolder(index) {
    const folders = copyProjectFolders();
    const oldName = folders[index]?.name;
    if (oldName === undefined) return;
    const name = await actionDialog({
      title: "Rename folder",
      message: "Enter a new name for this folder.",
      inputLabel: "Folder name",
      inputValue: oldName,
      confirmLabel: "Rename",
      cancelLabel: "Cancel"
    });
    if (!name || name === oldName) return;
    folders[index].name = name;
    if (collapsedProjectFolders().has(oldName)) {
      setProjectFolderCollapsed(oldName, false);
      setProjectFolderCollapsed(name, true);
    }
    await saveProjectFolders(folders, "Rename folder");
  }

  async function deleteProjectFolder(index) {
    const folders = copyProjectFolders();
    const folder = folders[index];
    if (!folder) return;
    const count = folder.projects.length;
    const confirmed = await actionDialog({
      title: "Delete folder",
      message: count
        ? `Delete folder "${folder.name}"? Its ${count} project${count === 1 ? "" : "s"} will move back to the top level; no project is deleted.`
        : `Delete the empty folder "${folder.name}"?`,
      confirmLabel: "Delete folder",
      cancelLabel: "Cancel",
      danger: true
    });
    if (confirmed !== true) return;
    folders.splice(index, 1);
    setProjectFolderCollapsed(folder.name, false);
    await saveProjectFolders(folders, "Delete folder");
  }

  async function moveProjectToFolder(name, target) {
    const folders = copyProjectFolders();
    const source = folders.findIndex(folder => folder.projects.includes(name));
    if (source === target) return;
    if (source >= 0) folders[source].projects = folders[source].projects.filter(project => project !== name);
    if (target !== null) {
      folders[target].projects.push(name);
      setProjectFolderCollapsed(folders[target].name, false);
    }
    await saveProjectFolders(folders, "Move project");
  }

  $("#new-folder").onclick = createProjectFolder;
  const projectList = $("#projects");
  const projectDropTarget = target => {
    const folder = target.closest("[data-folder-drop]");
    return folder ? Number(folder.dataset.folderDrop) : null;
  };
  const clearProjectDropTarget = () => [projectList, ...projectList.querySelectorAll(".drop-target")]
    .forEach(element => element.classList.remove("drop-target"));
  projectList.onclick = event => {
    const toggle = event.target.closest("[data-folder-toggle]");
    if (toggle) {
      const folder = projectFolders[Number(toggle.dataset.folderToggle)];
      const element = toggle.closest(".project-folder");
      const collapsed = !element.classList.contains("collapsed");
      element.classList.toggle("collapsed", collapsed);
      toggle.setAttribute("aria-expanded", String(!collapsed));
      if (folder) setProjectFolderCollapsed(folder.name, collapsed);
      return;
    }
    const rename = event.target.closest("[data-folder-rename]");
    if (rename) return renameProjectFolder(Number(rename.dataset.folderRename));
    const remove = event.target.closest("[data-folder-delete]");
    if (remove) return deleteProjectFolder(Number(remove.dataset.folderDelete));
    const project = event.target.closest(".project");
    if (project) openProject(project.dataset.name);
  };
  projectList.addEventListener("dragstart", event => {
    const project = event.target.closest(".project");
    if (!project) return;
    event.dataTransfer.setData(PROJECT_DRAG_TYPE, project.dataset.name);
    event.dataTransfer.effectAllowed = "move";
    project.classList.add("dragging");
  });
  projectList.addEventListener("dragend", event => {
    event.target.closest(".project")?.classList.remove("dragging");
    clearProjectDropTarget();
  });
  projectList.addEventListener("dragover", event => {
    if (!event.dataTransfer.types.includes(PROJECT_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const target = event.target.closest("[data-folder-drop]") || projectList;
    if (target.classList.contains("drop-target")) return;
    clearProjectDropTarget();
    target.classList.add("drop-target");
  });
  projectList.addEventListener("dragleave", event => {
    if (!projectList.contains(event.relatedTarget)) clearProjectDropTarget();
  });
  projectList.addEventListener("drop", event => {
    const name = event.dataTransfer.getData(PROJECT_DRAG_TYPE);
    clearProjectDropTarget();
    if (!name) return;
    event.preventDefault();
    moveProjectToFolder(name, projectDropTarget(event.target));
  });

  // --- Submission ----------------------------------------------------------

  // Offer only the projects that share the current project's folder; an
  // ungrouped project is offered alongside the other ungrouped ones.
  const upstreamSubmitAssignment = submitAssignment;
  submitAssignment = async function submitAssignmentFromFolder() {
    await upstreamSubmitAssignment();
    if (!current) return;
    const folder = projectFolders.find(entry => entry.projects.includes(current.name));
    const grouped = new Set(projectFolders.flatMap(entry => entry.projects));
    document.querySelectorAll("#submission-projects [data-submission-project]").forEach(input => {
      const offered = folder ? folder.projects.includes(input.value) : !grouped.has(input.value);
      if (!offered) input.closest(".submission-project").remove();
    });
  };
  $("#submit").onclick = submitAssignment;

  // Without a desktop file manager (e.g. Studio opened in a browser),
  // download the submission ZIP instead of opening its folder.
  const upstreamApi = api;
  api = async function apiWithSubmissionDownload(url, options = {}) {
    if (url !== "/api/submission/reveal") return upstreamApi(url, options);
    try {
      return await upstreamApi(url, options);
    } catch (error) {
      const {archive} = JSON.parse(options.body);
      const link = document.createElement("a");
      link.href = "/api/submission/download?archive=" + encodeURIComponent(archive);
      link.download = "";
      document.body.append(link);
      link.click();
      link.remove();
      const note = "The submission folder could not be opened (" + error.message +
        "), so the ZIP was downloaded by the browser instead.";
      lastNormalLog += "\n\n" + note;
      lastAdvancedLog += "\n\n" + note;
      updateLog();
      return {ok: true};
    }
  };

  // --- RISC-V manual -------------------------------------------------------

  // Mnemonics come from the RISC-V manual so highlighting and the reference
  // cover the same instructions. Longest first, so fence.i wins over fence.
  const OPCODE_PATTERN = new RegExp("\\b(c[._][a-z][\\w.]*|" + RISCV_MANUAL
    .filter(entry => entry.extension !== "Directive" && entry.extension !== "C")
    .map(entry => entry.mnemonic)
    .sort((a, b) => b.length - a.length)
    .map(mnemonic => mnemonic.replace(/\./g, "\\.") + (/^(?:lr|sc|amo)/.test(mnemonic) ? "(?:\\.aqrl|\\.aq|\\.rl)?" : ""))
    .join("|") + ")\\b", "gi");

  // Upstream highlights its own opcode list; mark the manual's other
  // mnemonics in whatever text it left outside a span or an HTML entity.
  const upstreamHighlightAsmLine = highlightAsmLine;
  highlightAsmLine = function highlightManualOpcodes(line) {
    let depth = 0;
    return upstreamHighlightAsmLine(line).split(/(<[^>]*>|&[#\w]+;)/).map(part => {
      if (part.startsWith("<")) {
        depth += part.startsWith("</") ? -1 : 1;
        return part;
      }
      if (depth || part.startsWith("&")) return part;
      return part.replace(OPCODE_PATTERN, '<span class="opcode">$&</span>');
    }).join("");
  };

  const manual = createManual({
    pane: $("#manual"),
    highlight: line => highlightAsmLine(line),
    escapeHtml,
    openCpuConfiguration
  });

  // Opens the manual on the instruction under `index` in `text`, or on the
  // search box when there is no word there.
  function lookUpInstruction(text, index) {
    let start = index;
    let end = index;
    while (start > 0 && /[\w.]/.test(text[start - 1])) start--;
    while (end < text.length && /[\w.]/.test(text[end])) end++;
    const word = text.slice(start, end);
    showTab("manual");
    if (word) manual.open(word);
    else manual.focusSearch();
  }

  async function refreshManualConfig() {
    if (!current) {
      manual.setConfig(null);
      return;
    }
    const name = current.name;
    try {
      const config = await api("/api/config?name=" + encodeURIComponent(name));
      if (current?.name !== name) return;
      manual.setConfig({...config, cpu: studioFeatures.multiIssueCpu ? config.cpu : "in-order"});
    } catch {
      manual.setConfig(null);
    }
  }

  const upstreamShowTab = showTab;
  showTab = function showTabWithManual(tab) {
    upstreamShowTab(tab);
    $("#manual").hidden = tab !== "manual";
  };

  const upstreamOpenProject = openProject;
  openProject = async function openProjectWithManual(...args) {
    const opened = await upstreamOpenProject(...args);
    refreshManualConfig();
    return opened;
  };

  const upstreamClearCurrentProject = clearCurrentProject;
  clearCurrentProject = function clearCurrentProjectAndManual(...args) {
    const result = upstreamClearCurrentProject(...args);
    manual.setConfig(null);
    return result;
  };

  const cpuForm = $("#cpu-form");
  const upstreamCpuSubmit = cpuForm.onsubmit;
  cpuForm.onsubmit = async event => {
    await upstreamCpuSubmit.call(cpuForm, event);
    refreshManualConfig();
  };

  const upstreamRenderPipeline = renderPipeline;
  renderPipeline = function renderPipelineWithLookup(...args) {
    const result = upstreamRenderPipeline(...args);
    $("#pipeline-grid").onclick = event => {
      if (!event.ctrlKey && !event.metaKey) return;
      const cell = event.target.closest(".inst[data-row]");
      if (cell) lookUpInstruction(cell.textContent.trim().split(/\s+/)[0], 0);
    };
    return result;
  };

  $("#body").addEventListener("click", event => {
    if (!event.ctrlKey && !event.metaKey) return;
    lookUpInstruction(event.target.value, event.target.selectionStart);
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "F1" || event.defaultPrevented) return;
    if (document.querySelector("dialog[open]")) return;
    event.preventDefault();
    showTab("manual");
    manual.focusSearch();
  });

  // --- Vim mode ------------------------------------------------------------

  const vimMode = createVimMode({
    editor: $("#body"),
    bar: $("#vim-bar"),
    status: $("#vim-status"),
    pending: $("#vim-pending"),
    message: $("#vim-message"),
    commandLine: $("#vim-command"),
    scrollArea: () => document.querySelector(".editor-area"),
    lineElement: lineNumber => document.querySelector(`.source-line[data-line="${lineNumber}"]`),
    isActive: () => Boolean(current),
    change(start, end, replacement, selectionStart) {
      if (editTouchesProtected($("#body").value, start, end)) return false;
      applyEditorChange(start, end, replacement, selectionStart, selectionStart, null);
      return true;
    },
    undo: undoEditor,
    redo: redoEditor,
    save,
    search(query) {
      $("#search").value = query;
      syncEditor();
    },
    lookup: position => lookUpInstruction($("#body").value, position)
  });

  // Runs in the capture phase on the editor's parent, so after the global
  // shortcuts but before studio.js's own editor handler, which a handled
  // key never reaches. Opcode completion keeps its keys while it is open.
  const COMPLETION_KEYS = new Set(["Tab", "ISO_Left_Tab", "ArrowUp", "ArrowDown", "Escape"]);
  document.querySelector(".editor-wrap").addEventListener("keydown", event => {
    if (event.target !== $("#body")) return;
    if (event.key === "F1") {
      event.preventDefault();
      event.stopPropagation();
      lookUpInstruction(event.target.value, event.target.selectionStart);
      return;
    }
    if ((opcodeSnippetSession || opcodePopupState)
        && (COMPLETION_KEYS.has(event.key) || event.code === "Tab")) return;
    if (vimMode.handleKeydown(event)) event.stopPropagation();
  }, true);

  const VIM_MODE_KEY = "ase-studio-vim-mode";
  $("#vim-mode").checked = localStorage.getItem(VIM_MODE_KEY) === "on";
  vimMode.setEnabled($("#vim-mode").checked);
  $("#vim-mode").onchange = event => {
    localStorage.setItem(VIM_MODE_KEY, event.target.checked ? "on" : "off");
    vimMode.setEnabled(event.target.checked);
    if (current) $("#body").focus();
  };

  // --- Run Step follows the current instruction ----------------------------

  const PIPELINE_ROW_HEIGHT = 27;

  // The current step is the most advanced instruction in the cycle (the one
  // writing back or committing when there is one); ties go to the oldest row.
  function playbackStepRow(rows, cycle) {
    const rank = {S: 0.5, F: 1, D: 2, R: 3, I: 4, E: 5, M: 6, C: 7, W: 8};
    let best = -1;
    let bestRank = 0;
    rows.forEach((row, index) => {
      const stage = row.cycles[cycle] || "";
      const value = Math.max(0, ...[...stage].map(marker => rank[marker] || 0));
      if (value > bestRank) {
        best = index;
        bestRank = value;
      }
    });
    return best;
  }

  function scrollPipelineToSelection() {
    const scroll = $("#pipeline-scroll");
    const header = scroll.querySelector(".pipeline-header")?.offsetHeight || 0;
    if (selectedRow !== null) {
      const top = selectedRow * PIPELINE_ROW_HEIGHT;
      const visibleHeight = scroll.clientHeight - header;
      if (top < scroll.scrollTop) scroll.scrollTop = top;
      else if (top + PIPELINE_ROW_HEIGHT > scroll.scrollTop + visibleHeight) {
        scroll.scrollTop = top + PIPELINE_ROW_HEIGHT - visibleHeight;
      }
    }
    if (selectedColumn !== null) {
      const style = getComputedStyle(document.documentElement);
      const fixed = ["--address-width", "--instruction-width", "--flow-width"]
        .reduce((total, name) => total + (parseFloat(style.getPropertyValue(name)) || 0), 0);
      const cellWidth = Number($("#cell-width").value);
      const left = (selectedColumn - 1) * cellWidth;
      const visibleWidth = scroll.clientWidth - fixed;
      if (left < scroll.scrollLeft) scroll.scrollLeft = left;
      else if (left + cellWidth > scroll.scrollLeft + visibleWidth) {
        scroll.scrollLeft = left + cellWidth - visibleWidth;
      }
    }
  }

  // Selects the current step's row and source line, and scrolls it into view.
  function showPlaybackStep() {
    if (!stepMode || !pipelineData || playbackCycle === null) return;
    const rows = displayedPipelineRows();
    const row = playbackStepRow(rows, playbackCycle);
    selectedRow = row >= 0 ? row : null;
    renderPipeline();
    scrollPipelineToSelection();
    highlightSourceLine(row >= 0 ? rows[row].sourceLine : null);
  }

  const upstreamRunStep = runStep;
  runStep = async function runStepAndFollow() {
    await upstreamRunStep();
    showPlaybackStep();
  };
  $("#step").onclick = runStep;

  const upstreamMovePlaybackCycle = movePlaybackCycle;
  movePlaybackCycle = function movePlaybackCycleAndFollow(delta) {
    upstreamMovePlaybackCycle(delta);
    showPlaybackStep();
  };

  document.addEventListener("keydown", event => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    // The pipeline scrollbar thumbs use the arrows while they have focus.
    if (event.defaultPrevented) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (!stepMode || !pipelineData || playbackCycle === null) return;
    if (event.target.closest("input, textarea, select, [contenteditable]")) return;
    if (document.querySelector("dialog[open]")) return;
    event.preventDefault();
    movePlaybackCycle(event.key === "ArrowLeft" ? -1 : 1);
  });

  // --- Memory --------------------------------------------------------------

  // .space/.skip/.zero reserve raw bytes, so view them as words rather than
  // byte by byte (memoryDisplayLayout widens them to doubles).
  const upstreamAvailableMemorySymbols = availableMemorySymbols;
  availableMemorySymbols = function availableMemorySymbolsAsWords() {
    return upstreamAvailableMemorySymbols().map(symbol =>
      symbol.untypedStorage && symbol.elementSize < 4 && symbol.size % 4 === 0
        ? {...symbol, elementSize: 4, elementCount: symbol.size / 4}
        : symbol);
  };

  // studio.js may have listed projects or opened one before this file ran.
  loadProjects().catch(() => {});
  if (current) refreshManualConfig();
})();
