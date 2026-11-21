"""Stage the pinned PP-OCRv6 detector and Latin-script recognizer."""

import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import unicodedata
import urllib.request

import numpy as np
import onnx
from onnx import numpy_helper

BASE = "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0"
MODELS = {
    "det": ("tiny", "ff6ab415b0a6e0c488550f2fb5d5046f1719848df220b2dc21b56402a65bc05d",
            "193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8"),
    "rec": ("small", "d267ab077a44a0eedb1ea8f8c542d263f211de8e9d7a029bf9fcfff7e5a88fb1",
            "5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634"),
}
LICENSE = "https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/v3.7.0/LICENSE"


def digest(contents):
    return hashlib.sha256(contents).hexdigest()


def fetch(url, limit):
    with urllib.request.urlopen(url, timeout=45) as source:
        data = source.read(limit + 1)
    if len(data) > limit:
        raise ValueError(f"Download exceeds the expected length: {url}")
    return data


def dictionary(config):
    lines = iter(config.decode("utf-8").splitlines())
    if not any(line == "  character_dict:" for line in lines):
        raise ValueError("PaddleOCR character dictionary is missing.")
    characters = []
    for line in lines:
        if not line.startswith("  - "):
            break
        value = line[4:]
        if value.startswith('"') and value.endswith('"'):
            value = json.loads(value)
        elif value.startswith("'") and value.endswith("'"):
            value = value[1:-1].replace("''", "'")
        if not value or "\0" in value:
            raise ValueError("Invalid PaddleOCR character.")
        characters.append(value)
    if len(characters) != 18708:
        raise ValueError("Unexpected PP-OCRv6 Small dictionary size.")
    return ["", *characters, " "]


def latin_character(value):
    return (not value or 32 <= ord(value[0]) <= 126 or value in "’‘“”…–—¿¡" or
            unicodedata.name(value[0], "").startswith("LATIN "))


def stage_recognizer(source, characters, target):
    # Keep the learned image features and reduce the final CTC classifier to
    # the Latin alphabet, punctuation and the blank symbol for English dialogue.
    keep = [index for index, character in enumerate(characters) if latin_character(character)]
    model = onnx.load_model_from_string(source)
    weights = {tensor.name: tensor for tensor in model.graph.initializer}
    for name in ("linear_8.w_0", "linear_8.b_0"):
        tensor = weights[name]
        array = numpy_helper.to_array(tensor)
        if array.shape[-1] != len(characters):
            raise ValueError("PP-OCRv6 classifier and dictionary do not match.")
        tensor.CopyFrom(numpy_helper.from_array(np.take(array, keep, axis=-1), name))
    for value in (*model.graph.value_info, *model.graph.output):
        for dimension in value.type.tensor_type.shape.dim:
            if dimension.dim_value == len(characters):
                dimension.dim_value = len(keep)
    (target / "rec.onnx").write_bytes(model.SerializeToString())
    (target / "characters.bin").write_bytes(("\0".join(characters[i] for i in keep[1:]) + "\0").encode("utf-8"))


def stage(cache, runtime):
    cache.mkdir(parents=True, exist_ok=True)
    (runtime / "licenses").mkdir(parents=True, exist_ok=True)
    target = runtime / "paddle"
    target.mkdir(parents=True, exist_ok=True)
    for kind, (size, archive_hash, model_hash) in MODELS.items():
        name = f"PP-OCRv6_{size}_{kind}_onnx_infer.tar"
        archive = cache / name
        data = archive.read_bytes() if archive.is_file() else b""
        if digest(data) != archive_hash:
            data = fetch(f"{BASE}/{name}", 32 * 1024 * 1024)
            if digest(data) != archive_hash:
                raise ValueError(f"PaddleOCR archive SHA-256 mismatch: {name}")
            archive.write_bytes(data)
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as packaged:
            members = {Path(item.name).name: item for item in packaged if item.isfile()}
            model = packaged.extractfile(members["inference.onnx"]).read()
            if digest(model) != model_hash:
                raise ValueError(f"PaddleOCR model SHA-256 mismatch: {name}")
            if kind == "rec":
                config = packaged.extractfile(members["inference.yml"]).read()
                stage_recognizer(model, dictionary(config), target)
            else:
                (target / "det.onnx").write_bytes(model)
    license_file = cache / "PaddleOCR-LICENSE"
    if not license_file.is_file():
        license_file.write_bytes(fetch(LICENSE, 64 * 1024))
    (runtime / "licenses" / "paddleocr.txt").write_bytes(license_file.read_bytes())


if __name__ == "__main__":
    stage(Path(sys.argv[1]), Path(sys.argv[2]))
