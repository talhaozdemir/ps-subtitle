"""Collect the ARM ELF and the recursive library closure from a Debian build host."""

import pathlib
import re
import shutil
import subprocess
import sys


def bundle(binary, output):
    lib = output / "lib"
    licenses = output / "licenses"
    tessdata = output / "tessdata"
    for directory in (output, lib, licenses, tessdata):
        directory.mkdir(parents=True, exist_ok=True)
    executable = output / "subtitle-engine"
    shutil.copy2(binary, executable)
    subprocess.run(["arm-linux-gnueabihf-strip", executable], check=True)
    sources = (
        pathlib.Path("/usr/lib/arm-linux-gnueabihf"),
        pathlib.Path("/lib/arm-linux-gnueabihf"),
        pathlib.Path("/usr/arm-linux-gnueabihf/lib"),
    )

    def required(path):
        output_text = subprocess.check_output(["arm-linux-gnueabihf-readelf", "-d", path], text=True)
        return set(re.findall(r"\(NEEDED\).*Shared library: \[([^]]+)\]", output_text))

    pending = required(executable) | {"ld-linux-armhf.so.3"}
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
        for path in (original, original.resolve()):
            owned = subprocess.run(["dpkg-query", "-S", path], text=True, capture_output=True)
            for line in owned.stdout.splitlines():
                package = line.split(": ", 1)[0].partition(":")[0]
                copyright_file = pathlib.Path("/usr/share/doc", package, "copyright")
                if copyright_file.is_file():
                    shutil.copyfile(copyright_file, licenses / (package + ".txt"))

    shutil.copy2("/usr/share/tesseract-ocr/5/tessdata/eng.traineddata", tessdata / "eng.traineddata")
    shutil.copy2("/usr/share/doc/tesseract-ocr-eng/copyright", licenses / "tesseract-ocr-eng.txt")
    print(f"Bundled ARM executable, {len(bundled)} shared libraries and English OCR data.")


if __name__ == "__main__":
    bundle(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]))
