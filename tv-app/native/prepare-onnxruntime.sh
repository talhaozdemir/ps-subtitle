#!/usr/bin/env bash
set -euo pipefail

staging="${1:?Pass a writable staging directory}"
mkdir -p "$staging"/apt/{lists,archive}/partial "$staging/sysroot"
staging="$(cd "$staging" && pwd)"
touch "$staging/apt/empty-status"
printf '%s\n' 'deb [arch=armhf] https://deb.debian.org/debian trixie main' > "$staging/apt/sources.list"
apt_args=(
    -o "Dir::Etc::sourcelist=$staging/apt/sources.list"
    -o 'Dir::Etc::sourceparts=-'
    -o 'APT::Architecture=armhf'
    -o 'APT::Architectures=armhf'
    -o "Dir::State::status=$staging/apt/empty-status"
    -o "Dir::State::lists=$staging/apt/lists"
    -o "Dir::Cache::archives=$staging/apt/archive"
    -o 'Dir::Cache::pkgcache=' -o 'Dir::Cache::srcpkgcache='
    -o 'Acquire::Languages=none'
    -o 'Debug::NoLocking=true'
)
apt-get "${apt_args[@]}" update
apt-get "${apt_args[@]}" -y --download-only --no-install-recommends install libonnxruntime-dev:armhf=1.21.0+dfsg-1

for package in "$staging"/apt/archive/*.deb; do
    dpkg-deb --extract "$package" "$staging/sysroot"
done
