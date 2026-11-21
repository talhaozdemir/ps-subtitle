"""Collect the ARM ELF and the recursive library closure from a Debian build host."""

import pathlib
import re
import shutil
import subprocess
import sys


def bundle(binary, output, ort):
    lib = output / "lib"
    licenses = output / "licenses"
    for directory in (lib, licenses):
        directory.mkdir(parents=True, exist_ok=True)
    executable = output / "subtitle-engine"
    shutil.copy2(binary, executable)
    subprocess.run(["arm-linux-gnueabihf-strip", executable], check=True)
    sources = (
        ort / "usr/lib/arm-linux-gnueabihf",
        ort / "usr/lib",
        pathlib.Path("/usr/lib/arm-linux-gnueabihf"),
        pathlib.Path("/lib/arm-linux-gnueabihf"),
        pathlib.Path("/usr/arm-linux-gnueabihf/lib"),
    )

    def required(path):
        output_text = subprocess.check_output(["arm-linux-gnueabihf-readelf", "-d", path], text=True)
        return set(re.findall(r"\(NEEDED\).*Shared library: \[([^]]+)\]", output_text))

    pending = required(executable) | {"ld-linux-armhf.so.3", "libonnxruntime.so.1.21"}
    bundled = set()
    while pending:
        name = min(pending)
        pending.remove(name)
        if name in bundled:
            continue
        original = next((directory / name for directory in sources if (directory / name).is_file()), None)
        if original is None:
            raise FileNotFoundError(name)
        shutil.copy2(original, lib / name)
        bundled.add(name)
        pending.update(required(original) - bundled)
        if original.is_relative_to(ort):
            continue
        for path in (original, original.resolve()):
            owned = subprocess.run(["dpkg-query", "-S", path], text=True, capture_output=True)
            for line in owned.stdout.splitlines():
                package = line.split(": ", 1)[0].partition(":")[0]
                copyright_file = pathlib.Path("/usr/share/doc", package, "copyright")
                if copyright_file.is_file():
                    shutil.copyfile(copyright_file, licenses / (package + ".txt"))

    for copyright_file in (ort / "usr/share/doc").glob("*/copyright"):
        shutil.copyfile(copyright_file, licenses / (copyright_file.parent.name + ".txt"))
    print(f"Bundled ARM executable and {len(bundled)} shared libraries.")


if __name__ == "__main__":
    bundle(*(pathlib.Path(value) for value in sys.argv[1:]))
