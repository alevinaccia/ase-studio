#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Behnam Farnaghinejad <behnam.farnaghinejad@polito.it>
# SPDX-License-Identifier: GPL-2.0-only
set -euo pipefail

launcher_only=false
case "${1:-}" in
  "") ;;
  --launcher-only) launcher_only=true ;;
  -h|--help)
    echo "Usage: ./install.sh [--launcher-only]"
    echo "  --launcher-only  Create launchers without installing system packages."
    exit 0
    ;;
  *)
    echo "Usage: ./install.sh [--launcher-only]" >&2
    exit 2
    ;;
esac

studio_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
host_root="$(cd "$studio_dir/.." && pwd)"
application_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
desktop_file="$application_dir/it.polito.ASEStudio.desktop"

install_system_dependencies() {
  if [[ ! -r /etc/os-release ]]; then
    echo "Cannot identify this Linux distribution." >&2
    return 1
  fi
  # shellcheck disable=SC1091
  source /etc/os-release
  local distro="${ID:-}"
  # Arch derivatives (CachyOS, EndeavourOS, ...) can use the Arch packages.
  if [[ " ${ID_LIKE:-} " == *" arch "* ]]; then
    distro="arch"
  fi
  case "$distro" in
    ubuntu|debian|linuxmint|pop)
      sudo apt-get update
      sudo apt-get install -y python3 python3-gi gir1.2-gtk-3.0 \
        gir1.2-webkit2-4.1 desktop-file-utils xdg-user-dirs
      ;;
    fedora)
      local manager="dnf"
      command -v dnf5 >/dev/null 2>&1 && manager="dnf5"
      sudo "$manager" install -y python3 python3-gobject gtk3 webkit2gtk4.1 \
        desktop-file-utils xdg-user-dirs
      ;;
    arch|manjaro)
      sudo pacman -Syu --needed --noconfirm python python-gobject gtk3 \
        webkit2gtk-4.1 desktop-file-utils xdg-user-dirs
      ;;
    *)
      echo "Unsupported Linux distribution: ${ID:-unknown}." >&2
      echo "Install Python 3, PyGObject, GTK 3, and WebKitGTK 4.1, then run this installer again." >&2
      return 1
      ;;
  esac
}

if ! python3 -c 'import gi; gi.require_version("Gtk", "3.0"); gi.require_version("WebKit2", "4.1")' 2>/dev/null; then
  if [[ "$launcher_only" == true ]]; then
    echo "ASE Studio's GTK/WebKit runtime is not available." >&2
    echo "Run ./utils/installation.sh ase-studio on a machine that still needs GUI dependencies." >&2
    exit 1
  fi
  echo "Installing the native ASE Studio runtime dependencies..."
  install_system_dependencies
fi
if ! python3 -c 'import gi; gi.require_version("Gtk", "3.0"); gi.require_version("WebKit2", "4.1")' 2>/dev/null; then
  echo "Python GTK and WebKitGTK 4.1 bindings are still unavailable." >&2
  exit 1
fi

mkdir -p "$application_dir"
{
  echo "[Desktop Entry]"
  echo "Version=1.0"
  echo "Type=Application"
  echo "Name=ASE Studio"
  echo "Comment=RISC-V assembly and pipeline teaching studio"
  printf 'TryExec=%s\n' "$studio_dir/launch.sh"
  printf 'Exec=env "ASE_STUDIO_HOST_ROOT=%s" "%s"\n' "$host_root" "$studio_dir/launch.sh"
  printf 'Path=%s\n' "$host_root"
  printf 'Icon=%s\n' "$studio_dir/frontend/icon.png"
  echo "Terminal=false"
  echo "Categories=Education;"
  echo "StartupNotify=true"
  echo "StartupWMClass=ASEStudio"
} > "$desktop_file"
chmod 0644 "$desktop_file"

desktop_dir=""
if command -v xdg-user-dir >/dev/null 2>&1; then
  desktop_dir="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
fi
if [[ -z "$desktop_dir" && -d "$HOME/Desktop" ]]; then
  desktop_dir="$HOME/Desktop"
fi
if [[ -n "$desktop_dir" && -d "$desktop_dir" ]]; then
  desktop_shortcut="$desktop_dir/ASE Studio.desktop"
  install -m 0755 "$desktop_file" "$desktop_shortcut"
  if command -v gio >/dev/null 2>&1; then
    gio set "$desktop_shortcut" metadata::trusted true >/dev/null 2>&1 || true
  fi
  echo "Desktop shortcut installed at: $desktop_shortcut"
else
  echo "No desktop directory was detected; the application-menu launcher was installed."
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$application_dir" >/dev/null 2>&1 || true
fi

echo "ASE Studio was installed for the current user."
echo "Open it from the application menu or run: $host_root/ase-studio.sh"
