#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
build="${1:?Pass a writable build directory}"
output="${2:?Pass a runtime output directory}"
pinned=43728af2e639fecb8a7af1cd68c29820a40de973
mkdir -p "$build" "$output"
build="$(cd "$build" && pwd)"
output="$(cd "$output" && pwd)"
chiaki="$build/chiaki-ng"
if [ ! -d "$chiaki/.git" ]; then
    git init "$chiaki"
    git -C "$chiaki" remote add origin https://github.com/streetpea/chiaki-ng.git
fi
if [ "$(git -C "$chiaki" rev-parse HEAD 2>/dev/null || true)" != "$pinned" ]; then
    git -C "$chiaki" fetch --depth 1 origin "$pinned"
    git -C "$chiaki" checkout --detach FETCH_HEAD
fi
git -C "$chiaki" submodule update --init --depth 1 third-party/curl third-party/nanopb

export PKG_CONFIG_LIBDIR=/usr/lib/arm-linux-gnueabihf/pkgconfig:/usr/share/pkgconfig
cmake -S "$root" -B "$build/build" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE="$root/armhf.cmake" \
    -DCHIAKI_SOURCE="$chiaki" -DPYTHON_EXECUTABLE=/usr/bin/python3 \
    -DOPENSSL_CRYPTO_LIBRARY=/usr/lib/arm-linux-gnueabihf/libcrypto.so \
    -DOPENSSL_SSL_LIBRARY=/usr/lib/arm-linux-gnueabihf/libssl.so \
    -DOPENSSL_INCLUDE_DIR=/usr/include
cmake --build "$build/build" --target subtitle-engine --parallel 4
python3 "$root/bundle.py" "$build/build/subtitle-engine" "$output"
cp "$chiaki/COPYING" "$output/licenses/chiaki-ng.txt"
cp "$chiaki/third-party/curl/COPYING" "$output/licenses/curl.txt"
cp "$chiaki/third-party/nanopb/LICENSE.txt" "$output/licenses/nanopb.txt"
