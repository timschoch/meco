#!/usr/bin/env python3
"""Export EdgeFace to ONNX once, and prove the export is faithful.

Idiap publishes `edgeface_xs_gamma_06` only as a PyTorch checkpoint. meco-faces
runs ONNX Runtime and nothing else, so the conversion has to happen somewhere —
and the place it must not happen is at boot. This script runs on a laptop, the
`.onnx` it writes is committed, and the image copies that file in.

It is also the only thing that ever compares the two runtimes. A conversion that
silently changes an operator does not fail; it returns 512 confident floats that
no longer match anyone. So the script embeds the ONNX output against the PyTorch
output on real aligned faces and refuses to finish if they have drifted, then
writes the PyTorch Face Prints out as `edgeface-reference.json` so the TypeScript
test can keep making the same comparison without a Python interpreter.

The faces it uses are the committed 112x112 squares in `fixtures/faces/aligned/`,
written by `align-dump.ts` with the service's own warp. Reading them rather than
re-implementing the alignment in numpy is the point: the reference Face Prints
then describe exactly the pixels meco-faces will send the model.

Environment
-----------
PyTorch has no wheels for every Python, so pin one it does support::

    uv venv --python 3.12 .temp/edgeface-venv
    uv pip install --python .temp/edgeface-venv/bin/python \
        torch torchvision timm onnx onnxruntime numpy pillow
    .temp/edgeface-venv/bin/python packages/faces/scripts/export-edgeface.py

Nothing in the service needs any of this. It is a one-off.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
MODELS = REPO / "packages" / "faces" / "models"
ALIGNED = REPO / "fixtures" / "faces" / "aligned"
REFERENCE = REPO / "fixtures" / "faces" / "edgeface-reference.json"
CHECKOUT = REPO / ".temp" / "edgeface-checkout"

MODEL_NAME = "edgeface_xs_gamma_06"
ONNX_PATH = MODELS / f"{MODEL_NAME}.onnx"

EDGEFACE_REPO = "https://github.com/otroshi/edgeface.git"

# Pinned, because "the current state of a research repository" is not a
# provenance. This commit is what the committed .onnx was made from; changing it
# means re-running this script and committing a different model.
EDGEFACE_COMMIT = "ce86851cfc37979a9cd2558598d0e9bc592cbba3"

# The commit already fixes the weights — the checkpoints are plain git blobs in
# that repository, not LFS pointers — so this is belt and braces. It is cheap,
# and it is the one line that would notice a rewritten tag or a poisoned mirror.
CHECKPOINT_SHA256 = "5ae7504cd9aee0a5d52c2115fd2eb66b0985dd1730f40134b5854e0cb658ce16"

# Below this the export has changed the network, whatever the file size says.
MIN_COSINE = 0.99

# The network's input, fixed by the training recipe: RGB, channels first,
# 112x112, scaled to [-1, 1].
SIZE = 112

# opset 17 is the oldest that carries every operator `edgenext_x_small` uses
# without the exporter decomposing LayerNorm into a dozen primitives, and it is
# far below what onnxruntime-node 1.29 accepts. Raising it gains nothing here.
OPSET = 17


def run(*args: str, cwd: Path | None = None) -> str:
    """A git call that says what went wrong instead of returning an empty string."""
    done = subprocess.run(
        args, cwd=cwd, check=True, capture_output=True, text=True
    )
    return done.stdout.strip()


def fetch_checkpoint() -> Path:
    """Put the pinned commit on disk, fetching only what the export reads.

    A full clone is 205 MB of checkpoints for the five variants nobody here
    wants. A blobless partial clone with a sparse checkout brings the one
    checkpoint, the model code and the licence, and fetching the commit by its
    hash means no branch has to be trusted to still point at it.
    """
    if not (CHECKOUT / ".git").exists():
        CHECKOUT.mkdir(parents=True, exist_ok=True)
        run("git", "init", "--quiet", cwd=CHECKOUT)
        run("git", "remote", "add", "origin", EDGEFACE_REPO, cwd=CHECKOUT)

    run(
        "git", "fetch", "--quiet", "--depth", "1", "--filter=blob:none",
        "origin", EDGEFACE_COMMIT, cwd=CHECKOUT,
    )
    run("git", "sparse-checkout", "init", "--no-cone", cwd=CHECKOUT)
    run(
        "git", "sparse-checkout", "set", "--no-cone",
        "/backbones/", f"/checkpoints/{MODEL_NAME}.pt", "/LICENSE",
        cwd=CHECKOUT,
    )
    run("git", "checkout", "--quiet", "--force", EDGEFACE_COMMIT, cwd=CHECKOUT)

    head = run("git", "rev-parse", "HEAD", cwd=CHECKOUT)
    if head != EDGEFACE_COMMIT:
        raise SystemExit(f"checked out {head}, wanted {EDGEFACE_COMMIT}")

    checkpoint = CHECKOUT / "checkpoints" / f"{MODEL_NAME}.pt"
    digest = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
    print(f"edgeface   {EDGEFACE_COMMIT}")
    print(f"checkpoint {checkpoint.name}  sha256 {digest}")
    if digest != CHECKPOINT_SHA256:
        raise SystemExit(f"checkpoint sha256 is {digest}, expected {CHECKPOINT_SHA256}")
    return checkpoint


def load_faces():
    """The committed aligned squares, as one [N, 3, 112, 112] batch in [-1, 1]."""
    import numpy as np
    from PIL import Image

    names = sorted(p.name for p in ALIGNED.glob("*.png"))
    if not names:
        raise SystemExit(
            f"no aligned faces in {ALIGNED}. Run `pnpm --filter meco-faces dump:aligned` first."
        )

    batch = np.empty((len(names), 3, SIZE, SIZE), dtype=np.float32)
    for i, name in enumerate(names):
        image = Image.open(ALIGNED / name).convert("RGB")
        if image.size != (SIZE, SIZE):
            raise SystemExit(f"{name} is {image.size}, not {SIZE}x{SIZE}")
        # ToTensor() then Normalize(0.5, 0.5): [0, 255] -> [0, 1] -> [-1, 1].
        batch[i] = np.asarray(image, dtype=np.float32).transpose(2, 0, 1) / 127.5 - 1.0
    return names, batch


def main() -> None:
    import numpy as np
    import onnxruntime as ort
    import torch

    checkpoint = fetch_checkpoint()
    sys.path.insert(0, str(CHECKOUT))
    from backbones import get_model  # noqa: E402  (needs the checkout on the path)

    model = get_model(MODEL_NAME)
    model.load_state_dict(torch.load(checkpoint, map_location="cpu", weights_only=True))
    model.eval()

    names, batch = load_faces()
    print(f"faces      {len(names)} aligned squares from fixtures/faces/aligned/")

    MODELS.mkdir(parents=True, exist_ok=True)
    # A dynamic batch axis so a group photograph is one inference rather than
    # one per face. Every other dimension is fixed: the network has exactly one
    # input size and pretending otherwise would only invite a caller to try.
    torch.onnx.export(
        model,
        (torch.zeros(1, 3, SIZE, SIZE),),
        str(ONNX_PATH),
        input_names=["face"],
        output_names=["print"],
        dynamic_axes={"face": {0: "faces"}, "print": {0: "faces"}},
        opset_version=OPSET,
        do_constant_folding=True,
        # The TorchScript exporter, deliberately, despite the deprecation
        # notice torch 2.9 prints: the `dynamo=True` path needs `onnxscript` as
        # a further dependency, and the tracer already reproduces the model to
        # cosine 1.000000 on every fixture face. Revisit when the old exporter
        # is removed, not before — and re-run the comparison below when doing so.
        dynamo=False,
    )
    print(f"wrote      {ONNX_PATH.relative_to(REPO)}  ({ONNX_PATH.stat().st_size / 1e6:.2f} MB)")

    with torch.no_grad():
        reference = model(torch.from_numpy(batch)).numpy()

    session = ort.InferenceSession(str(ONNX_PATH), providers=["CPUExecutionProvider"])
    exported = session.run(["print"], {"face": batch})[0]

    def unit(v):
        return v / np.linalg.norm(v, axis=-1, keepdims=True)

    reference_unit = unit(reference)
    cosines = (reference_unit * unit(exported)).sum(axis=-1)

    print()
    worst = 1.0
    for name, cosine in zip(names, cosines):
        worst = min(worst, float(cosine))
        print(f"  {'ok  ' if cosine > MIN_COSINE else 'FAIL'} {name:<38} cosine {cosine:.6f}")
    print(f"\nworst {worst:.6f}, needs > {MIN_COSINE}")

    if worst <= MIN_COSINE:
        raise SystemExit("the ONNX export does not reproduce the PyTorch model")

    REFERENCE.write_text(
        json.dumps(
            {
                "$comment": [
                    "PyTorch reference Face Prints for the squares in aligned/, written by",
                    "packages/faces/scripts/export-edgeface.py. Each Face Print is the",
                    "edgeface_xs_gamma_06 output for the file of the same name, L2-normalised.",
                    "The embed test asserts meco-faces' ONNX output has cosine similarity",
                    "above 0.99 with each of these. Regenerate whenever the alignment, the",
                    "model or the export changes: run dump:aligned, then this script.",
                ],
                "model": MODEL_NAME,
                "source": {
                    "repository": EDGEFACE_REPO,
                    "commit": EDGEFACE_COMMIT,
                    "checkpoint": checkpoint.name,
                    "checkpointSha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
                },
                "torch": torch.__version__,
                "opset": OPSET,
                "minCosine": MIN_COSINE,
                "prints": {
                    name: [round(float(v), 7) for v in print_]
                    for name, print_ in zip(names, reference_unit)
                },
            },
            indent=2,
        )
        + "\n"
    )
    print(f"wrote      {REFERENCE.relative_to(REPO)}")


if __name__ == "__main__":
    main()
