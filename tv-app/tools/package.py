"""Stage the LG app and service and package them using LG's ares-package CLI."""

import argparse
import hashlib
import io
import json
import os
import pathlib
import shutil
import struct
import subprocess
import tarfile
import tempfile
import zlib

PACK_SHA256 = "5196776c454db1db03b07355b5f3b454ae7dedeeda46a1ddc9642ee7aca7fd84"
EXECUTABLES = {
    "usr/palm/services/com.gtavi.turkce.altyazi/runtime/subtitle-engine",
    "usr/palm/services/com.gtavi.turkce.altyazi/runtime/lib/ld-linux-armhf.so.3",
}


def png_chunk(tag, payload):
    return (struct.pack(">I", len(payload)) + tag + payload
            + struct.pack(">I", zlib.crc32(tag + payload)))


def icon():
    width = 80
    raw = bytearray()
    for y in range(width):
        raw.append(0)
        for x in range(width):
            caption = (14 <= x < 66 and 23 <= y < 57)
            line = (23 <= x < 57 and 33 <= y < 37) or (23 <= x < 49 and 43 <= y < 47)
            raw.extend((37, 26, 33) if line else (255, 188, 174) if caption else (47, 34, 42))
    return (b"\x89PNG\r\n\x1a\n"
            + png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, width, 8, 2, 0, 0, 0))
            + png_chunk(b"IDAT", zlib.compress(raw))
            + png_chunk(b"IEND", b""))


def fix_archive_modes(path):
    """ares-package uses Windows file modes when run on Windows."""
    contents = path.read_bytes()
    if contents[:8] != b"!<arch>\n":
        raise ValueError("ares-package did not produce a Debian archive.")
    output = io.BytesIO()
    output.write(contents[:8])
    position = 8
    executable_paths = set()
    while position < len(contents):
        header = contents[position:position + 60]
        if header[58:] != b"\x60\n":
            raise ValueError("Invalid Debian archive member.")
        size = int(header[48:58])
        name = header[:16].strip().rstrip(b"/")
        position += 60
        data = contents[position:position + size]
        position += size + size % 2
        if name == b"data.tar.gz":
            compressed = io.BytesIO()
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as source, \
                    tarfile.open(fileobj=compressed, mode="w:gz", compresslevel=6) as target:
                for member in source:
                    local_name = member.name.lstrip("./")
                    if local_name in EXECUTABLES:
                        member.mode = 0o755
                        executable_paths.add(local_name)
                    elif member.isdir():
                        member.mode = 0o755
                    elif member.isfile():
                        member.mode = 0o644
                    target.addfile(member, source.extractfile(member) if member.isfile() else None)
            data = compressed.getvalue()
        output.write(header[:48] + f"{len(data):<10}".encode("ascii") + header[58:])
        output.write(data)
        if len(data) % 2:
            output.write(b"\n")
    if executable_paths != EXECUTABLES:
        raise ValueError("An ARM executable was missing from the package payload.")
    path.write_bytes(output.getvalue())


def package(options):
    root = pathlib.Path(__file__).resolve().parents[1]
    if hashlib.sha256(options.pack.read_bytes()).hexdigest() != PACK_SHA256:
        raise ValueError("GTA VI pack does not match the v5 catalog checksum.")

    for binary in (options.runtime / "subtitle-engine", options.runtime / "lib/ld-linux-armhf.so.3"):
        with binary.open("rb") as file:
            header = file.read(20)
        if not (header[:6] == b"\x7fELF\x01\x01" and header[18:20] == b"\x28\x00"):
            raise ValueError(f"{binary} is not a 32-bit ARM ELF.")

    output = options.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="gtavi-ipk-") as directory:
        stage = pathlib.Path(directory)
        app = stage / "app"
        service = stage / "service"
        packed = stage / "packed"
        packed.mkdir()
        shutil.copytree(root / "app", app)
        shutil.copytree(root / "service", service)
        shutil.copytree(options.runtime, service / "runtime")
        shutil.copy2(options.pack, service / "gta-6.json.gz")
        shutil.copy2(root / "LICENSE", app / "LICENSE")
        shutil.copy2(root / "README.md", app / "README.md")
        (app / "icon.png").write_bytes(icon())
        subprocess.run(["node", options.cli.resolve(), "-o", packed, app, service], check=True)
        metadata = json.loads((app / "appinfo.json").read_text(encoding="utf-8"))
        artifact = packed / f"{metadata['id']}_{metadata['version']}_all.ipk"
        fix_archive_modes(artifact)
        destination = output / artifact.name
        temporary = destination.with_suffix(".ipk.new")
        try:
            shutil.copy2(artifact, temporary)
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)
        return destination


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("runtime", "pack", "cli", "output"):
        parser.add_argument("--" + name, type=pathlib.Path, required=True)
    print(package(parser.parse_args()))
