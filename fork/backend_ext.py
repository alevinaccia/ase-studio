"""Fork-only backend additions, run inside backend.py's namespace.

backend.py executes this file just before its ``__main__`` block, so every
upstream function and class is already defined here and can be wrapped by
rebinding its name. Upstream code looks names up when it calls them, so the
wrappers take effect everywhere, and ``Handler`` is replaced by a subclass
before native.py or the ``__main__`` block builds the server.

Keep fork changes in this file rather than in backend.py; see FORK.md.
"""

import subprocess as _subprocess_module

# VERSION stays upstream's; FORK_VERSION carries this fork's build suffix.
STUDIO_VERSION = (f"{STUDIO_VERSION}+"
                  + (STUDIO_ROOT / "FORK_VERSION").read_text(encoding="utf-8").strip())

FORK_FRONTEND_STYLES = ("fork/fork.css",)
FORK_FRONTEND_SCRIPTS = ("fork/vim.js", "fork/manual-data.js", "fork/manual.js",
                         "fork/fork.js")


# --- Project folders --------------------------------------------------------

def project_folders_file() -> Path:
    """Store sidebar folders next to the projects without nesting them."""
    return active_programs_directory() / ".ase-studio-folders.json"


def validate_project_folders(value, projects):
    """Return folders that name only existing projects, each at most once."""
    if not isinstance(value, list):
        fail("Invalid project folders.")
    folders, names, placed = [], set(), set()
    for entry in value:
        if not isinstance(entry, dict):
            fail("Invalid project folders.")
        try:
            name = validate_project_name(entry.get("name"))
        except ValueError:
            fail("Enter a non-empty folder name without '/'.")
        if name in names:
            fail(f'A folder named "{name}" already exists.')
        members = entry.get("projects", [])
        if not isinstance(members, list):
            fail("Invalid project folders.")
        kept = [member for member in members
                if isinstance(member, str) and member in projects
                and member not in placed]
        placed.update(kept)
        names.add(name)
        folders.append({"name": name, "projects": kept})
    return folders


def existing_project_names():
    programs = active_programs_directory()
    if not programs.is_dir():
        fail(f"The configured programs folder is unavailable: {programs}", 500)
    return {p.name for p in programs.iterdir() if p.is_dir()}


def write_project_folders(folders):
    path = project_folders_file()
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps({"folders": folders}, indent=2) + "\n")
    temporary.replace(path)


def load_project_folders():
    """Return the saved folders, dropping projects that no longer exist.

    Dropped names are written back, so a deleted project does not reappear
    in its old folder when a new project later takes its name.
    """
    path = project_folders_file()
    try:
        saved = json.loads(path.read_text()).get("folders", [])
        folders = validate_project_folders(saved, existing_project_names())
    except (OSError, ValueError, AttributeError):
        return []
    if folders != saved:
        try:
            write_project_folders(folders)
        except OSError:
            pass
    return folders


def save_project_folders(value):
    folders = validate_project_folders(value, existing_project_names())
    write_project_folders(folders)
    return {"ok": True, "folders": folders}


def update_project_folders(old_name: str, new_name: str, after=None):
    """Follow a project rename or copy in the folder file.

    With ``after``, ``new_name`` is added next to that project instead of
    replacing ``old_name``.
    """
    path = project_folders_file()
    if not path.exists():
        return
    try:
        folders = json.loads(path.read_text()).get("folders", [])
    except (OSError, ValueError, AttributeError):
        return
    changed = False
    for folder in folders:
        members = folder.get("projects") if isinstance(folder, dict) else None
        if not isinstance(members, list) or (after or old_name) not in members:
            continue
        index = members.index(after or old_name)
        if after:
            members.insert(index + 1, new_name)
        else:
            members[index] = new_name
        changed = True
    if changed:
        path.write_text(json.dumps({"folders": folders}, indent=2) + "\n")


_upstream_rename_project = rename_project


def rename_project(old_name: str, new_name: str):
    result = _upstream_rename_project(old_name, new_name)
    update_project_folders(old_name, result.get("name", new_name))
    return result


_upstream_duplicate_project = duplicate_project


def duplicate_project(source_name: str, new_name: str):
    result = _upstream_duplicate_project(source_name, new_name)
    update_project_folders(source_name, result.get("name", new_name), after=source_name)
    return result


# --- Submission download ----------------------------------------------------

def submission_archive(archive_path):
    """Resolve a completed submission ZIP inside the active submissions folder."""
    if not isinstance(archive_path, str) or not archive_path:
        fail("The submission archive path is missing.")
    archive = resolve_environment_path(archive_path)
    try:
        archive.relative_to(active_submission_directory())
    except ValueError:
        fail("Invalid submission archive path.")
    if not archive.is_file() or archive.suffix.lower() != ".zip":
        fail("The submission ZIP could not be found.", 404)
    return archive


# --- gem5 build freshness ---------------------------------------------------

def gem5_built_commit_path(executable):
    """Return the file recording which source commit an executable was built from."""
    executable = Path(executable)
    return executable.with_name(executable.name + ".source-commit")


def gem5_build_freshness(checkout=None):
    """Report whether the gem5 executable was built from its checked-out source.

    A pull that succeeds while the rebuild that follows it fails or is
    interrupted leaves new source next to an old executable, and Git alone
    then reports gem5 as up to date. Each successful rebuild records its
    commit; builds made before that record existed are compared by date.
    """
    checkout = checkout or configured_gem5_checkout()
    if not checkout.get("managed"):
        return {"stale": False}
    repository = Path(checkout["path"])
    executable = Path(checkout["executable"])
    ok, head = git_run(["rev-parse", "HEAD"], cwd=repository)
    if not ok:
        return {"stale": False}
    try:
        built = gem5_built_commit_path(executable).read_text(encoding="utf-8").strip()
    except OSError:
        built = ""
    if built:
        stale = built != head
    else:
        ok, committed = git_run(["log", "-1", "--format=%ct", "HEAD"], cwd=repository)
        try:
            stale = ok and int(committed) > executable.stat().st_mtime
        except (OSError, ValueError):
            stale = False
    message = ("gem5: the executable was not built from the checked-out "
               f"source ({head[:10]}) and must be rebuilt." if stale else "")
    return {"stale": stale, "sourceCommit": head, "builtCommit": built,
            "message": message}


def record_gem5_built_commit(repository, executable):
    ok, head = git_run(["rev-parse", "HEAD"], cwd=repository)
    if ok:
        try:
            gem5_built_commit_path(executable).write_text(head + "\n", encoding="utf-8")
        except OSError:
            pass


class _StreamingSubprocess:
    """Stand-in for the subprocess module that lets the SCons build print live.

    Command-line updates use it so a long build does not look hung; every
    other command still runs with its output captured.
    """

    def __getattr__(self, name):
        return getattr(_subprocess_module, name)

    def run(self, command, *args, **kwargs):
        if Path(str(command[0])).name != "scons":
            return _subprocess_module.run(command, *args, **kwargs)
        kwargs.pop("capture_output", None)
        print(f"$ {shlex.join(command)}", flush=True)
        result = _subprocess_module.run(command, *args, **kwargs)
        result.stdout = result.stderr = ""
        return result


_upstream_rebuild_configured_gem5 = rebuild_configured_gem5


def rebuild_configured_gem5(repository, stream=False):
    """Rebuild gem5 and record the commit it was built from.

    With ``stream`` the build prints straight to this process's terminal.
    """
    global subprocess
    if stream:
        subprocess = _StreamingSubprocess()
    try:
        rebuilt, output = _upstream_rebuild_configured_gem5(repository)
    finally:
        subprocess = _subprocess_module
    if rebuilt:
        record_gem5_built_commit(repository, configured_gem5_checkout()["executable"])
    return rebuilt, output


_upstream_gem5_update_status = gem5_update_status


def gem5_update_status(refresh=False):
    status = _upstream_gem5_update_status(refresh)
    if not status.get("managed"):
        return status
    freshness = gem5_build_freshness()
    status["rebuildNeeded"] = freshness["stale"]
    if freshness["stale"]:
        # A rebuild alone is an update the user can apply from the app.
        status["message"] = (freshness["message"] if not status["available"]
                             else status["message"] + " " + freshness["message"])
        status["canUpdate"] = not status.get("dirty")
    return status


_upstream_update_status = update_status


def update_status(refresh=False):
    status = _upstream_update_status(refresh)
    if not status["available"] and any(item.get("rebuildNeeded")
                                       for item in status["repositories"]):
        status["available"] = True
        status["canUpdate"] = not any(item.get("dirty")
                                      for item in status["repositories"])
    return status


_upstream_pull_update = pull_update


def pull_update(discard_local_changes=False):
    """Also rebuild gem5 when its executable is stale but nothing was pulled."""
    result = _upstream_pull_update(discard_local_changes)
    if not result.get("ok") or not gem5_build_freshness()["stale"]:
        return result
    rebuilt, output = rebuild_configured_gem5(Path(configured_gem5_checkout()["path"]))
    message = output + "\n\n" + result["output"]
    return {**result, "ok": rebuilt, "output": message, "advancedOutput": message}


_upstream_simulate = simulate


def simulate(name):
    result = _upstream_simulate(name)
    freshness = gem5_build_freshness()
    if freshness["stale"]:
        # An old executable runs without complaint but may still contain
        # simulator bugs that its newer source fixes.
        warning = (f"Warning: {freshness['message']} Results may not match the "
                   "current simulator; rebuild it with Update (on macOS: "
                   "./macos.sh update).\n\n")
        result["output"] = warning + result["output"]
        if "advancedOutput" in result:
            result["advancedOutput"] = warning + result["advancedOutput"]
    return result


# --- Command-line engine update (macos.sh) ----------------------------------

def update_gem5(gem5, stream=False):
    """Pull gem5 when it is behind, then rebuild if its executable is stale."""
    if not gem5.get("managed"):
        return True, []
    outputs = []
    if gem5.get("available"):
        command = (["pull", "--ff-only", "origin", gem5["branch"]]
                   if gem5["branch"] else
                   ["merge", "--ff-only", gem5["remoteRef"]])
        pulled, output = git_run(command, timeout=90, cwd=Path(gem5["path"]))
        if output:
            outputs.append(f"gem5:\n{output}")
        if not pulled:
            return False, outputs
    if gem5_build_freshness()["stale"]:
        rebuilt, build_output = rebuild_configured_gem5(Path(gem5["path"]), stream)
        outputs.append(build_output if not stream or not rebuilt
                       else "gem5 rebuild completed successfully.")
        return rebuilt, outputs
    return True, outputs


def update_engine_from_cli():
    """Update the simulator and gem5 from a terminal, outside the server.

    ``macos.sh start`` runs this before the server starts, so the gem5
    rebuild cannot be cut short by closing the app. ASE Studio itself is
    left alone: macos.sh replaces it with the local checkout right after.
    """
    simulator = repository_update_status(
        ROOT, "Simulator", refresh=True,
        ignored_paths=("ase_studio", *LOCAL_PARENT_PATHSPECS))
    gem5 = gem5_update_status(refresh=True)
    for item in (simulator, gem5):
        print(item["message"], flush=True)
    ok = True
    if simulator["available"]:
        if simulator.get("dirty"):
            print("Simulator: skipped, local tracked changes need a choice "
                  "in the app's Update dialog.", flush=True)
        else:
            local_snapshots, error = preserve_local_parent_files()
            if local_snapshots is None:
                print(f"Simulator: could not preserve local files: {error}", flush=True)
                ok = False
            else:
                command = (["pull", "--ff-only", "origin", simulator["branch"]]
                           if simulator["branch"] else
                           ["merge", "--ff-only", simulator["remoteRef"]])
                pulled, output = git_run(command, timeout=90, cwd=ROOT)
                restored, restore_error = restore_local_parent_files(local_snapshots)
                print(f"Simulator:\n{output}", flush=True)
                if not restored:
                    print(restore_error, flush=True)
                ok = ok and pulled and restored
    if gem5.get("dirty"):
        print("gem5: skipped, the checkout has local tracked changes.", flush=True)
        return False
    gem5_ok, outputs = update_gem5(gem5, stream=True)
    for output in outputs:
        print(output, flush=True)
    return ok and gem5_ok


_upstream_require_startup_repositories = require_startup_repositories


def require_startup_repositories():
    # The __main__ block calls this first, so --update-engine runs right
    # after the same startup check and before the server starts.
    _upstream_require_startup_repositories()
    if __name__ == "__main__" and "--update-engine" in sys.argv:
        raise SystemExit(0 if update_engine_from_cli() else 1)


# --- HTTP routes ------------------------------------------------------------

class Handler(Handler):
    def do_GET(self):
        url = urlparse(self.path)
        if url.path in {"/", "/index.html"}:
            return self.fork_respond(self.send_fork_index)
        if url.path == "/api/folders":
            return self.fork_respond(
                lambda: self.send_json({"folders": load_project_folders()}))
        if url.path == "/api/submission/download":
            return self.fork_respond(lambda: self.send_submission_archive(
                parse_qs(url.query).get("archive", [""])[0]))
        return super().do_GET()

    def do_POST(self):
        if self.path == "/api/folders":
            return self.fork_respond(lambda: self.send_json(
                save_project_folders(self.read_json().get("folders"))))
        return super().do_POST()

    def fork_respond(self, action):
        try:
            return action()
        except ValueError as error:
            message, status = error.args[0]
            return self.send_json({"error": message}, status)
        except Exception as error:
            return self.send_json({"error": str(error)}, 500)

    def send_fork_index(self):
        """Serve upstream's index.html with the fork's styles and scripts added."""
        page = (FRONTEND / "index.html").read_text(encoding="utf-8")
        styles = "".join(f'<link rel="stylesheet" href="{href}">'
                         for href in FORK_FRONTEND_STYLES)
        scripts = "".join(f'<script src="{src}"></script>'
                          for src in FORK_FRONTEND_SCRIPTS)
        page = page.replace("</head>", styles + "</head>", 1)
        page = page.replace("</body>", scripts + "</body>", 1)
        data = page.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_submission_archive(self, archive_path):
        archive = submission_archive(archive_path)
        data = archive.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Disposition",
                         f'attachment; filename="{archive.name}"')
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
