# This fork

`alevinaccia/ase-studio` is a fork of
[cad-polito-it/ase-studio](https://github.com/cad-polito-it/ase-studio).
`main` here is upstream `main` plus this fork's additions:

- an optional Vim mode for the editor
- a searchable RISC-V manual tab, linked from the editor (Ctrl/⌘-click, F1,
  Vim `K`) and the pipeline, that shows each instruction's timing under the
  project's CPU configuration; editor highlighting covers every mnemonic in it
- project folders in the sidebar, and a submission dialog that offers only
  the current folder's projects
- Run Step that follows the current instruction, with ←/→ to move between
  cycles
- `.space` buffers shown as words in the memory view
- downloading the submission ZIP when its folder cannot be opened
- rebuilding gem5 whenever its executable was not built from its checked-out
  source, with a warning on simulations run with a stale build
- running on Apple Silicon Macs via OrbStack (`./macos.sh`, see below)

## Where fork code lives

Upstream edits `backend.py`, `frontend/index.html`, `frontend/studio.js` and
`frontend/studio.css` in almost every release, so the fork does not edit them.
Its code lives in files upstream does not have, and hooks into upstream's at
runtime:

| File | What it does |
| --- | --- |
| `fork/backend_ext.py` | Run inside `backend.py`'s namespace just before its `__main__` block. Wraps upstream functions by rebinding their names, subclasses `Handler` for new routes, and adds the fork's styles and scripts to `index.html` when serving it. |
| `frontend/fork/fork.js` | Loaded after `studio.js`. Adds the fork's markup and wraps upstream functions by reassigning them (studio.js's top-level names are shared globals). |
| `frontend/fork/fork.css` | Loaded after `studio.css`, so it can override it. |
| `frontend/fork/vim.js`, `manual.js`, `manual-data.js` | Vim mode and the manual. |
| `FORK_VERSION` | The fork's build suffix (see below). |
| `macos.sh`, `FORK.md` | Fork-only. |

The only edit to an upstream file is the 3-line loader just above
`if __name__ == "__main__":` in `backend.py`. Merging upstream therefore
conflicts only if upstream changes those exact lines.

Rules for new fork work:

- Put it in the fork files above, never in upstream's files. To change what
  an upstream function does, wrap it (save the original, rebind the name, call
  the original from the wrapper) rather than editing it.
- A handler that studio.js bound to a function directly
  (`$("#step").onclick = runStep`) still holds the original, so rebind it
  after wrapping, as `fork.js` does.
- Keep `fork.js`'s own names inside its wrapper function so a name upstream
  adds later can never clash with one of ours.
- After merging upstream, check that what the fork wraps still exists and
  does the same job (`grep` for the names that `fork.js` and
  `backend_ext.py` save as `upstream…`).

## Version

`VERSION` is always upstream's. The app reports
`<VERSION>+<FORK_VERSION>`, for example `1.6.2+av.5`, so a build from this
fork is never mistaken for an official release. Bump the number in
`FORK_VERSION` when you add something.

## Remotes

```bash
git remote -v
# origin    https://github.com/alevinaccia/ase-studio.git     (this fork, push here)
# upstream  https://github.com/cad-polito-it/ase-studio.git   (read-only for us)
```

A fresh clone needs the upstream remote added once:

```bash
git remote add upstream https://github.com/cad-polito-it/ase-studio.git
```

## Pulling in upstream changes

```bash
git switch main
git fetch upstream
git merge upstream/main
git push origin main
```

## Adding something

```bash
git switch -c feat/<name> main
# ...commit...
git switch main
git merge --ff-only feat/<name>
git push origin main
```

Keep the feature branch if you might offer it upstream as a pull request later.

## Running on macOS (Apple Silicon)

The simulator tools and the native window are Linux-only, so on a Mac ASE
Studio runs inside a lightweight Ubuntu 22.04 machine managed by
[OrbStack](https://orbstack.dev) and is used from a Mac browser. The machine is
native arm64, so nothing runs under x86 emulation.

Requirements: an Apple Silicon Mac, OrbStack, and about 10 GB of free disk.

1. Install OrbStack and open it once:

   ```bash
   brew install --cask orbstack
   ```

2. Get this repository on the Mac:

   ```bash
   git clone https://github.com/alevinaccia/ase-studio.git
   cd ase-studio
   ```

3. Create the Linux machine and install everything inside it. This compiles
   the RISC-V toolchain and gem5 from source and takes 30-90 minutes:

   ```bash
   ./macos.sh setup
   ```

4. Start ASE Studio. It opens `http://localhost:8765` in your browser:

   ```bash
   ./macos.sh start
   ```

Use `./macos.sh stop`, `restart`, `status`, or `logs` to manage the server.
`start` also boots OrbStack and the machine when they are stopped.

`start` and `restart` first copy this checkout into the machine, so the server
runs the ASE Studio files you have on the Mac (`./macos.sh sync` copies them
without restarting; frontend changes then need only a browser reload). Keep the
checkout up to date with `git pull`, or set `ASE_SYNC=0` to keep running the
copy installed in the machine, for example after using the in-app updater.
The in-app *Update* button updates the official copy inside the machine; the
next `./macos.sh start` or `./macos.sh sync` puts this fork's code back.

`start` and `restart` also pull the simulator and gem5 from upstream and
rebuild gem5 whenever its executable was not built from its checked-out source,
showing the build in the terminal. They also list upstream ASE Studio commits
this checkout does not include yet. `./macos.sh update` does only this; set
`ASE_UPDATE=0` to skip it, for example when offline.

Projects, results, and submissions live inside the machine under
`~/ase_riscv_gem5_sim`. From macOS they are reachable in Finder at
`~/OrbStack/ase/home/<user>/ase_riscv_gem5_sim`. Submissions are also
downloaded by the browser when they are created. Actions that open Linux
desktop applications, such as **Open with…** and the tool installers in
Settings, are not available in the browser.
