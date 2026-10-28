#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alessandro Vinaccia <vinacciaalessandro@gmail.com>
# SPDX-License-Identifier: GPL-2.0-only
# Run ASE Studio on macOS (Apple Silicon) inside an OrbStack Ubuntu machine and
# use it from a Mac browser. See "Running on macOS" in FORK.md.
#
# Usage: ./macos.sh [setup|start|stop|restart|status|logs|open|sync|update]   (default: start)
#
# start also updates the simulator and gem5 from upstream (rebuilding gem5 when
# its executable is older than its source) and reports upstream ASE Studio
# commits this checkout does not have yet. update does only that.
#
# Environment overrides:
#   ASE_MACHINE             OrbStack machine name (default: ase)
#   ASE_STUDIO_PORT         Port served to the Mac browser (default: 8765)
#   ASE_SYNC                0 to skip copying this checkout into the machine on start
#   ASE_UPDATE              0 to skip the upstream updates and checks on start
set -euo pipefail

machine="${ASE_MACHINE:-ase}"
port="${ASE_STUDIO_PORT:-8765}"
url="http://localhost:${port}"
unit="ase-studio"
# The installer's gem5 build requires Python 3.10, which Ubuntu 22.04 ships.
distro="ubuntu:jammy"
simulator_repository="https://github.com/cad-polito-it/ase_riscv_gem5_sim.git"
# Paths inside the Linux machine ($HOME there is /home/<Mac user name>).
repo="/home/${USER}/ase_riscv_gem5_sim"
launcher="/home/${USER}/.ase-server.py"
studio_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
studio_target="${repo}/ase_studio"

in_vm() { orb -m "$machine" bash -lc "$1"; }

require_orbstack() {
    if [[ "$(uname -s)" != "Darwin" ]]; then
        echo "This script is for macOS. On Linux, use utils/installation.sh in the simulator repository." >&2
        exit 1
    fi
    if ! command -v orb >/dev/null 2>&1; then
        echo "OrbStack is required. Install it with: brew install --cask orbstack" >&2
        echo "or download it from https://orbstack.dev, open it once, then run this script again." >&2
        exit 1
    fi
    orb start >/dev/null 2>&1
}

machine_exists() { orb list 2>/dev/null | awk '{print $1}' | grep -qx "$machine"; }

setup() {
    require_orbstack
    if machine_exists; then
        echo "Using the existing OrbStack machine '${machine}'."
    else
        echo "Creating the OrbStack machine '${machine}' (${distro})..."
        orb create "$distro" "$machine"
    fi
    orb start "$machine" >/dev/null 2>&1 || true

    echo "Installing git inside the machine..."
    in_vm "sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git >/dev/null"

    if in_vm "[ -d ${repo}/.git ]"; then
        echo "Using the existing simulator checkout at ${repo}."
    else
        echo "Cloning the simulator repository..."
        in_vm "git clone --branch main --recurse-submodules ${simulator_repository} ${repo}"
    fi

    echo "Installing the RISC-V toolchain, gem5 and ASE Studio."
    echo "Both tools are compiled from source: this takes 30-90 minutes."
    in_vm "cd ${repo} && DEBIAN_FRONTEND=noninteractive ./utils/installation.sh all-ase"
    echo
    echo "Setup complete. Start ASE Studio with: $0 start"
}

# Copy this checkout (tracked files plus new, non-ignored ones) over the ASE
# Studio installed in the machine, so local changes are what the server runs.
sync_studio() {
    if ! git -C "$studio_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        echo "Skipping sync: ${studio_dir} is not a git checkout."
        return
    fi
    in_vm "[ -d ${studio_target} ]" \
        || { echo "ASE Studio is not installed in the machine. Run: $0 setup" >&2; exit 1; }
    echo "Syncing ASE Studio from ${studio_dir} into the machine..."
    (
        cd "$studio_dir"
        git ls-files -z --cached --others --exclude-standard \
            | while IFS= read -r -d '' file; do [[ -f "$file" ]] && printf '%s\0' "$file"; done \
            | COPYFILE_DISABLE=1 tar --null -T - --no-xattrs --no-mac-metadata -cf -
    ) | orb -m "$machine" tar -C "$studio_target" -xf - --no-same-owner --warning=no-unknown-keyword
    ignore_synced_extras
}

# Files copied from this checkout that the machine's checkout does not track
# would block the in-app update when it checks out a release adding them. List
# them in that checkout's local exclude file: Git overwrites ignored files.
ignore_synced_extras() {
    git -C "$studio_dir" ls-files --cached --others --exclude-standard \
        | orb -m "$machine" bash -c '
            cd "$1" || exit 0
            exclude=$(git rev-parse --git-path info/exclude) || exit 0
            mkdir -p "$(dirname "$exclude")"
            tracked=$(mktemp)
            git ls-files | LC_ALL=C sort > "$tracked"
            {
                sed "/^# macos.sh sync start$/,/^# macos.sh sync end$/d" "$exclude" 2>/dev/null
                echo "# macos.sh sync start"
                LC_ALL=C sort | LC_ALL=C comm -23 - "$tracked" | sed "s|^|/|"
                echo "# macos.sh sync end"
            } > "$exclude.tmp" && mv "$exclude.tmp" "$exclude"
            rm -f "$tracked"' _ "$studio_target"
}

# Pull the simulator and gem5, and rebuild gem5 whenever its executable is
# older than its source. This runs here rather than in the app so a long
# rebuild is visible and cannot be cut short by closing the browser or server.
update_engine() {
    echo "Updating the simulator and gem5 (a gem5 rebuild can take a while)..."
    in_vm "cd ${repo} && ASE_STUDIO_HOST_ROOT=${repo} /usr/bin/python3 -u -m ase_studio.backend --update-engine" \
        || echo "Warning: the simulator or gem5 update did not complete; see the messages above." >&2
}

# This checkout replaces the machine's ASE Studio on every sync, so upstream
# ASE Studio fixes only arrive by rebasing it. Report what is missing; the
# rebase itself is left to the user because it can conflict.
check_upstream() {
    git -C "$studio_dir" remote get-url upstream >/dev/null 2>&1 || {
        echo "Note: no 'upstream' remote, so upstream ASE Studio updates are not checked." >&2
        echo "      Add it with: git -C \"${studio_dir}\" remote add upstream https://github.com/cad-polito-it/ase-studio.git" >&2
        return
    }
    if ! git -C "$studio_dir" fetch --quiet upstream 2>/dev/null; then
        echo "Warning: could not fetch upstream ASE Studio; its updates were not checked." >&2
        return
    fi
    local missing
    missing=$(git -C "$studio_dir" rev-list --count HEAD..upstream/main)
    if (( missing > 0 )); then
        echo "Upstream ASE Studio has ${missing} commit(s) this checkout does not include:"
        git -C "$studio_dir" log --oneline --no-decorate -10 HEAD..upstream/main | sed 's/^/  /'
        (( missing > 10 )) && echo "  ..."
        echo "Rebase onto them (see FORK.md), then run '$0 restart':"
        echo "  git -C \"${studio_dir}\" rebase upstream/main"
    else
        echo "ASE Studio includes every upstream commit."
    fi
}

is_running() { in_vm "systemctl is-active --quiet ${unit}"; }

wait_ready() {
    for _ in $(seq 1 60); do
        curl -fs -m 2 -o /dev/null "${url}/api/health" && return 0
        sleep 0.5
    done
    return 1
}

start() {
    require_orbstack
    machine_exists || { echo "The OrbStack machine '${machine}' does not exist. Run: $0 setup" >&2; exit 1; }
    orb start "$machine" >/dev/null 2>&1 || true
    # Right after boot the Mac home folder can take a moment to appear in the machine.
    in_vm "for i in \$(seq 1 30); do [ -f ${repo}/ase_studio/backend.py ] && exit 0; sleep 0.5; done; exit 1" \
        || { echo "ASE Studio is not installed in the machine. Run: $0 setup" >&2; exit 1; }
    [[ "${ASE_SYNC:-1}" == "0" ]] || sync_studio
    if [[ "${ASE_UPDATE:-1}" != "0" ]]; then
        check_upstream
        update_engine
    fi
    if is_running; then
        echo "ASE Studio is already running at ${url}"
        [[ "${ASE_SYNC:-1}" == "0" ]] || echo "Frontend changes are live after a browser reload; use '$0 restart' for backend changes."
        return
    fi
    if curl -fs -m 2 -o /dev/null "${url}/api/health"; then
        echo "Port ${port} is used by another server. Stop it or set ASE_STUDIO_PORT." >&2
        exit 1
    fi
    # Headless equivalent of native.py: the same backend, without the GTK window.
    orb -m "$machine" bash -c "cat > ${launcher}" <<EOF
import sys
sys.path.insert(0, "${repo}")
from http.server import ThreadingHTTPServer
from ase_studio.backend import Handler, require_startup_repositories
require_startup_repositories()
server = ThreadingHTTPServer(("127.0.0.1", ${port}), Handler)
print("ASE Studio serving on 127.0.0.1:${port}")
server.serve_forever()
EOF
    # systemd owns the server so it outlives this orb command. A plain background
    # process is killed when the command returns, especially right after a boot.
    in_vm "sudo systemctl reset-failed ${unit} 2>/dev/null; sudo systemd-run --quiet --unit=${unit} --collect \
        --uid=\$(id -u) --gid=\$(id -g) --working-directory=${repo} \
        --setenv=HOME=\$HOME --setenv=USER=\$USER --setenv=ASE_STUDIO_HOST_ROOT=${repo} \
        /usr/bin/python3 -u ${launcher}"
    if wait_ready; then
        echo "ASE Studio is running at ${url}"
    else
        echo "ASE Studio did not start. Last log lines:" >&2
        in_vm "journalctl -u ${unit} -n 20 --no-pager" >&2
        exit 1
    fi
}

stop() {
    require_orbstack
    if machine_exists && is_running; then
        in_vm "sudo systemctl stop ${unit}"
        echo "ASE Studio stopped."
    else
        echo "ASE Studio is not running."
    fi
}

case "${1:-start}" in
    setup) setup ;;
    start) start; open "$url" ;;
    stop) stop ;;
    restart) stop; start ;;
    status) require_orbstack; if machine_exists && is_running; then echo "running at ${url}"; else echo "stopped"; fi ;;
    logs) require_orbstack; in_vm "journalctl -u ${unit} -f --no-pager" ;;
    open) open "$url" ;;
    sync) require_orbstack; sync_studio ;;
    update) require_orbstack; check_upstream; [[ "${ASE_SYNC:-1}" == "0" ]] || sync_studio; update_engine ;;
    -h|--help|help) sed -n '4,17p' "$0" | sed 's/^# \{0,1\}//' ;;
    *) echo "Usage: $0 [setup|start|stop|restart|status|logs|open|sync|update]" >&2; exit 2 ;;
esac
