# This fork

`alevinaccia/ase-studio` is a fork of
[cad-polito-it/ase-studio](https://github.com/cad-polito-it/ase-studio).
`main` here is upstream `main` with this fork's own commits stacked on top:

- an optional Vim mode for the editor
- running on Apple Silicon Macs via OrbStack (`./macos.sh`)
- downloading the submission ZIP when its folder cannot be opened

`VERSION` reads `<upstream version>+av.<n>`, so a build from this fork is never
mistaken for an official release. Bump `<n>` when you add something, and reset
the upstream part when you rebase onto a new upstream release.

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
git rebase upstream/main
git push --force-with-lease origin main
```

On a conflict, fix the files, `git add` them and `git rebase --continue`.
If upstream changed `VERSION`, keep its number and re-append `+av.<n>`.

## Adding something

```bash
git switch -c feat/<name> main
# ...commit...
git switch main
git merge --ff-only feat/<name>
git push origin main
```

Keep the feature branch if you might offer it upstream as a pull request later.

## Running it on the Mac

`./macos.sh start` copies this checkout into the OrbStack machine, so the app
runs whatever is checked out here. The in-app *Update* button updates the
official copy inside the machine. The next `./macos.sh start` or
`./macos.sh sync` puts this fork's code back.
