"""Throughput-only graph rewrites for the packed Nonlocal ONNX bundle.

The accepted packed graph spends 92.6 % of its FLOPs in twenty dense 1x1
convolutions (800-channel and up) and ONNX Runtime's CUDA FP32 path runs them
through a legacy SIMT convolution kernel at about a third of cuBLAS SGEMM speed.
Its ten grouped 1x1 convolutions carry almost no arithmetic but run through a
cuDNN direct-convolution kernel that takes a third of the remaining time. The
rewrites remove those costs without changing a weight, a dtype or the set of
products summed for any output:

* drop provably all-zero Conv biases (the exporter materialises them as
  ``Expand(CastLike(0))`` nodes feeding three-input Convs);
* express every dense batch-1 1x1 Conv with at least ``--min-channels`` input
  channels as ``Reshape -> MatMul -> Reshape`` so the product runs as one GEMM;
* express every grouped batch-1 1x1 Conv with at least ``--min-channels`` input
  channels the same way, as one batched GEMM with the group as the batch.

The tool derives a new, separately hashed bundle from an accepted bundle and
records the source hash in the manifest; it never modifies or overwrites the
source. A derived bundle is not an accepted bundle until ``onnx_validate`` passes
on every fixture tile, CPU and CUDA, under the frozen gates.

Usage:
  python -m rapidraw_denoise.onnx_rewrite --bundle SRC --output NEW [--fixtures DIR]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tempfile
from pathlib import Path

import numpy as np

MIN_IN_CHANNELS = 256
MODEL_NAME = "model.onnx"
REPORT_NAME = "rewrite-report.json"
REWRITE_VERSION = "gemm-1x1-v2"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _is_zero_tensor(tensor) -> bool:
    from onnx import numpy_helper

    return not np.any(numpy_helper.to_array(tensor))


def _make_zero_test(model):
    """Return ``is_zero(name)``: True only when the tensor is provably all zero."""
    inits = {i.name: i for i in model.graph.initializer}
    producers = {o: n for n in model.graph.node for o in n.output}

    def is_zero(name: str, depth: int = 0) -> bool:
        if depth > 8:
            return False
        if name in inits:
            return _is_zero_tensor(inits[name])
        node = producers.get(name)
        if node is None:
            return False
        if node.op_type == "Constant":
            for attr in node.attribute:
                if attr.name == "value" and attr.HasField("t"):
                    return _is_zero_tensor(attr.t)
            return False
        if node.op_type == "ConstantOfShape":
            for attr in node.attribute:
                if attr.name == "value" and attr.HasField("t"):
                    return _is_zero_tensor(attr.t)
            return True  # ONNX default fill value is float 0
        if node.op_type in ("Expand", "CastLike", "Cast"):
            return is_zero(node.input[0], depth + 1)
        return False

    return is_zero


def _attributes(node) -> dict:
    from onnx import helper

    return {a.name: helper.get_attribute_value(a) for a in node.attribute}


def _is_pointwise(node, inits) -> bool:
    """A 1x1, stride-1, unpadded, undilated Conv with a constant weight (any group)."""
    a = _attributes(node)
    return (
        list(a.get("kernel_shape", [])) == [1, 1]
        and list(a.get("strides", [1, 1])) == [1, 1]
        and list(a.get("pads", [0, 0, 0, 0])) == [0, 0, 0, 0]
        and list(a.get("dilations", [1, 1])) == [1, 1]
        and a.get("auto_pad", b"NOTSET") in (b"NOTSET", "NOTSET")
        and len(node.input) >= 2
        and node.input[1] in inits
    )


def _referenced_names(graph) -> set[str]:
    names = {o.name for o in graph.output}

    def visit(g) -> None:
        for n in g.node:
            names.update(n.input)
            for attr in n.attribute:
                if attr.HasField("g"):
                    visit(attr.g)
                for sub in attr.graphs:
                    visit(sub)

    visit(graph)
    return names


def rewrite_model(model, min_in_channels: int = MIN_IN_CHANNELS, drop_zero_bias: bool = True,
                  dense_as_matmul: bool = True, grouped_as_matmul: bool = True):
    """Rewrite ``model`` in place and return a report dictionary."""
    import onnx
    from onnx import helper, numpy_helper, shape_inference

    inferred = shape_inference.infer_shapes(model)
    shapes: dict[str, list[int]] = {}
    for info in list(inferred.graph.value_info) + list(inferred.graph.input) + list(inferred.graph.output):
        dims = info.type.tensor_type.shape.dim
        shapes[info.name] = [d.dim_value if d.HasField("dim_value") else -1 for d in dims]

    graph = model.graph
    inits = {i.name: i for i in graph.initializer}
    is_zero = _make_zero_test(model)
    used_names = {n.name for n in graph.node if n.name} | set(inits)

    def unique(base: str) -> str:
        name, k = base, 0
        while name in used_names:
            k += 1
            name = f"{base}_{k}"
        used_names.add(name)
        return name

    new_nodes, new_inits = [], []
    biases_removed = converted = converted_grouped = 0
    converted_shapes: list[list[int]] = []
    grouped_shapes: list[list[int]] = []
    for node in graph.node:
        if node.op_type != "Conv":
            new_nodes.append(node)
            continue
        zero_bias = len(node.input) == 3 and is_zero(node.input[2])
        shape_in = shapes.get(node.input[0])
        groups = int(_attributes(node).get("group", 1))
        enabled = dense_as_matmul if groups == 1 else grouped_as_matmul
        if (enabled and _is_pointwise(node, inits) and shape_in is not None
                and len(shape_in) == 4 and shape_in[0] == 1 and min(shape_in) > 0
                and (len(node.input) == 2 or zero_bias)):
            weight = numpy_helper.to_array(inits[node.input[1]])
            out_ch, group_in = int(weight.shape[0]), int(weight.shape[1])
            in_ch = group_in * groups
            if (in_ch >= min_in_channels and weight.shape[2:] == (1, 1) and shape_in[1] == in_ch
                    and out_ch % groups == 0):
                _, _, height, width = shape_in
                tag = unique(f"{node.name or node.output[0]}_gemm")
                # [O, C/G, 1, 1] -> [G, O/G, C/G]; output channels of group g are contiguous.
                w_array = np.ascontiguousarray(weight.reshape(groups, out_ch // groups, group_in))
                if groups == 1:
                    w_array = w_array[0]
                w_init = numpy_helper.from_array(w_array, f"{tag}_w")
                flat = [groups, group_in, height * width] if groups > 1 else [1, in_ch, height * width]
                s_in = numpy_helper.from_array(np.array(flat, np.int64), f"{tag}_shape_in")
                s_out = numpy_helper.from_array(np.array([1, out_ch, height, width], np.int64), f"{tag}_shape_out")
                new_inits += [w_init, s_in, s_out]
                new_nodes += [
                    helper.make_node("Reshape", [node.input[0], s_in.name], [f"{tag}_in"], name=f"{tag}_reshape_in"),
                    helper.make_node("MatMul", [w_init.name, f"{tag}_in"], [f"{tag}_out"], name=f"{tag}_matmul"),
                    helper.make_node("Reshape", [f"{tag}_out", s_out.name], [node.output[0]], name=f"{tag}_reshape_out"),
                ]
                biases_removed += int(zero_bias)
                if groups == 1:
                    converted += 1
                    converted_shapes.append([out_ch, in_ch, height, width])
                else:
                    converted_grouped += 1
                    grouped_shapes.append([out_ch, in_ch, groups, height, width])
                continue
        if drop_zero_bias and zero_bias:
            node = onnx.NodeProto.FromString(node.SerializeToString())
            del node.input[2]
            biases_removed += 1
        new_nodes.append(node)

    del graph.node[:]
    graph.node.extend(new_nodes)
    graph.initializer.extend(new_inits)

    # Prune nodes and initializers that only fed the removed biases / converted weights.
    while True:
        used = _referenced_names(graph)
        live = [n for n in graph.node if any(o in used for o in n.output)]
        if len(live) == len(graph.node):
            break
        del graph.node[:]
        graph.node.extend(live)
    used = _referenced_names(graph)
    keep = [i for i in graph.initializer if i.name in used]
    pruned = len(graph.initializer) - len(keep)
    del graph.initializer[:]
    graph.initializer.extend(keep)
    return {
        "rewrite_version": REWRITE_VERSION,
        "zero_biases_removed": biases_removed,
        "dense_1x1_conv_to_matmul": converted,
        "grouped_1x1_conv_to_matmul": converted_grouped,
        "min_in_channels": min_in_channels,
        "converted_shapes_oc_ic_h_w": converted_shapes,
        "grouped_shapes_oc_ic_groups_h_w": grouped_shapes,
        "initializers_pruned": pruned,
    }


def _op_counts(model) -> dict[str, int]:
    counts: dict[str, int] = {}
    for n in model.graph.node:
        key = f"{n.domain or 'ai.onnx'}::{n.op_type}"
        counts[key] = counts.get(key, 0) + 1
    return dict(sorted(counts.items()))


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--bundle", type=Path, required=True, help="Accepted source bundle (model.onnx + manifest.json)")
    p.add_argument("--output", type=Path, required=True, help="New bundle directory to create (never overwritten)")
    p.add_argument("--min-channels", type=int, default=MIN_IN_CHANNELS)
    p.add_argument("--halo", type=int, default=None,
                   help="Record this tiling halo (and the matching retained core) in the derived "
                   "manifest; the graph itself is tile-size specific, not halo specific. "
                   "Default keeps the source manifest's geometry.")
    p.add_argument("--fixtures", type=Path, default=None,
                   help="Optional fixture dir; the rewritten graph must reproduce the source "
                   "graph's output on the first tile within 1e-5 on CPU before the bundle is written")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    try:
        import onnx

        source = args.bundle.resolve()
        output = args.output.resolve()
        if output.exists():
            raise ValueError(f"--output already exists (never overwrite): {output}")
        manifest = json.loads((source / "manifest.json").read_text())
        source_model = source / MODEL_NAME
        source_sha = sha256_file(source_model)
        if manifest.get("model_sha256") != source_sha:
            raise ValueError("Source manifest model hash does not match model.onnx")
        if manifest.get("precision") != "fp32" or manifest.get("diagnostic_shape"):
            raise ValueError("Only production FP32 bundles can be rewritten")

        if args.halo is not None:
            tile = manifest.get("tile")
            if type(tile) is not int or args.halo < 0 or args.halo % 4 or tile <= 2 * args.halo:
                raise ValueError(f"--halo must be a non-negative multiple of 4 below half the tile ({tile})")

        model = onnx.load(str(source_model))
        before_ops = _op_counts(model)
        report = rewrite_model(model, args.min_channels)
        if not (report["dense_1x1_conv_to_matmul"] or report["grouped_1x1_conv_to_matmul"]
                or report["zero_biases_removed"]):
            raise ValueError("No rewrite applied; refusing to create an identical bundle")
        onnx.checker.check_model(model, full_check=True)

        output.parent.mkdir(parents=True, exist_ok=True)
        tmp = Path(tempfile.mkdtemp(prefix=".onnx-rewrite-", dir=str(output.parent)))
        try:
            new_model = tmp / MODEL_NAME
            onnx.save(model, str(new_model))
            new_sha = sha256_file(new_model)
            check: dict = {"status": "not run (no --fixtures)"}
            if args.fixtures is not None:
                import onnxruntime as ort

                tiles = sorted((args.fixtures.resolve() / "tiles").glob("tile-*.npz"))
                if not tiles:
                    raise ValueError(f"No fixture tiles in {args.fixtures / 'tiles'}")
                with np.load(tiles[0], allow_pickle=False) as f:
                    x = np.ascontiguousarray(f["input"])
                options = ort.SessionOptions()
                options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
                outs = []
                for path in (source_model, new_model):
                    session = ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])
                    outs.append(session.run(None, {manifest["input_name"]: x})[0])
                worst = float(np.abs(outs[0].astype(np.float64) - outs[1]).max())
                if worst > 1e-5:
                    raise ValueError(f"Rewritten graph differs from the source graph by {worst:.3e} (> 1e-5)")
                check = {"status": "CPU, first fixture tile, rewritten vs source graph", "max_abs_diff": worst}
            summary = {
                **report,
                "source_model_sha256": source_sha,
                "model_sha256": new_sha,
                "operators_before": before_ops,
                "operators_after": _op_counts(model),
                "equivalence_check": check,
                "note": "Derived graph; accepted only after onnx_validate passes on every fixture tile "
                        "(CPU and CUDA) under the frozen gates.",
            }
            (tmp / REPORT_NAME).write_text(json.dumps(summary, indent=2) + "\n")
            derived = dict(manifest)
            derived["model_sha256"] = new_sha
            if args.halo is not None:
                derived["halo"] = args.halo
                derived["retained_core"] = manifest["tile"] - 2 * args.halo
            derived["graph_rewrites"] = {
                "version": REWRITE_VERSION,
                "source_model_sha256": source_sha,
                "zero_biases_removed": report["zero_biases_removed"],
                "dense_1x1_conv_to_matmul": report["dense_1x1_conv_to_matmul"],
                "grouped_1x1_conv_to_matmul": report["grouped_1x1_conv_to_matmul"],
                "min_in_channels": report["min_in_channels"],
            }
            derived["validation_report_file"] = REPORT_NAME
            derived["validation_report_sha256"] = sha256_file(tmp / REPORT_NAME)
            (tmp / "manifest.json").write_text(json.dumps(derived, indent=2) + "\n")
            sums = {n: sha256_file(tmp / n) for n in (MODEL_NAME, REPORT_NAME, "manifest.json")}
            (tmp / "SHA256SUMS.txt").write_text("".join(f"{h}  {n}\n" for n, h in sorted(sums.items())))
            tmp.rename(output)
        except BaseException:
            import shutil

            shutil.rmtree(tmp, ignore_errors=True)
            raise
        print(json.dumps({"status": "rewritten", "output": str(output), "model_sha256": new_sha,
                          "source_model_sha256": source_sha, **{k: report[k] for k in (
                              "zero_biases_removed", "dense_1x1_conv_to_matmul", "grouped_1x1_conv_to_matmul")}}, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"status": "error", "error": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
