"""Checks for the throughput-only ONNX graph rewrites (zero-bias removal, dense 1x1 Conv -> MatMul).

Synthetic graphs only; the accepted-bundle parity gates are recorded evidence, not part of this suite.
"""
import hashlib
import json

import numpy as np
import pytest

onnx = pytest.importorskip("onnx")
ort = pytest.importorskip("onnxruntime")
from onnx import TensorProto, helper, numpy_helper  # noqa: E402

from rapidraw_denoise import onnx_rewrite  # noqa: E402

RNG = np.random.default_rng(0)


def _initializer(name, array):
    return numpy_helper.from_array(np.asarray(array, np.float32), name)


def _zero_bias_nodes(prefix, channels):
    """The exporter's materialised zero bias: Constant -> CastLike -> Expand."""
    return [
        helper.make_node("Constant", [], [f"{prefix}_c"], name=f"{prefix}_c",
                         value=numpy_helper.from_array(np.array(0.0, np.float32))),
        helper.make_node("CastLike", [f"{prefix}_c", f"{prefix}_w"], [f"{prefix}_cl"], name=f"{prefix}_cl"),
        helper.make_node("Expand", [f"{prefix}_cl", f"{prefix}_shape"], [f"{prefix}_b"], name=f"{prefix}_e"),
    ]


def _model(nodes, inits, in_shape, out_shape, out_name):
    graph = helper.make_graph(
        nodes, "g",
        [helper.make_tensor_value_info("x", TensorProto.FLOAT, in_shape)],
        [helper.make_tensor_value_info(out_name, TensorProto.FLOAT, out_shape)], inits)
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 18)])
    model.ir_version = 10
    onnx.checker.check_model(model, full_check=True)
    return model


def _conv_model(*, in_ch=8, out_ch=6, hw=5, batch=1, kernel=1, group=1, zero_bias=True, bias_value=None):
    weight = RNG.standard_normal((out_ch, in_ch // group, kernel, kernel)).astype(np.float32)
    inits = [_initializer("conv_w", weight)]
    nodes, inputs = [], ["x", "conv_w"]
    if zero_bias:
        inits.append(numpy_helper.from_array(np.array([out_ch], np.int64), "conv_shape"))
        nodes += _zero_bias_nodes("conv", out_ch)
        inputs.append("conv_b")
    elif bias_value is not None:
        inits.append(_initializer("conv_b", np.full(out_ch, bias_value)))
        inputs.append("conv_b")
    pad = kernel // 2
    nodes.append(helper.make_node("Conv", inputs, ["y"], name="conv", kernel_shape=[kernel, kernel],
                                  pads=[pad] * 4, group=group))
    return _model(nodes, inits, [batch, in_ch, hw, hw], [batch, out_ch, hw, hw], "y")


def _run(model, x):
    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    session = ort.InferenceSession(model.SerializeToString(), options, providers=["CPUExecutionProvider"])
    return session.run(None, {"x": x})[0]


def _ops(model):
    return [n.op_type for n in model.graph.node]


def _check_equivalent(model, report_expectation, **kwargs):
    x = RNG.standard_normal([d.dim_value for d in model.graph.input[0].type.tensor_type.shape.dim]).astype(np.float32)
    before = _run(model, x)
    rewritten = onnx.ModelProto.FromString(model.SerializeToString())
    report = onnx_rewrite.rewrite_model(rewritten, **kwargs)
    onnx.checker.check_model(rewritten, full_check=True)
    np.testing.assert_allclose(_run(rewritten, x), before, atol=1e-5, rtol=1e-5)
    for key, value in report_expectation.items():
        assert report[key] == value, (key, report)
    return rewritten, report


def test_dense_1x1_with_zero_bias_becomes_matmul_and_stays_equivalent():
    model = _conv_model()
    rewritten, report = _check_equivalent(
        model, {"dense_1x1_conv_to_matmul": 1, "zero_biases_removed": 1}, min_in_channels=8)
    assert _ops(rewritten) == ["Reshape", "MatMul", "Reshape"]
    # The now-unused conv weight and the zero-bias chain are gone, not carried along.
    names = {i.name for i in rewritten.graph.initializer}
    assert "conv_w" not in names and "conv_shape" not in names
    assert report["initializers_pruned"] >= 2


def test_channel_threshold_leaves_small_1x1_as_conv_but_drops_its_zero_bias():
    rewritten, _ = _check_equivalent(
        _conv_model(in_ch=8), {"dense_1x1_conv_to_matmul": 0, "zero_biases_removed": 1}, min_in_channels=16)
    assert _ops(rewritten) == ["Conv"]
    assert len(rewritten.graph.node[0].input) == 2


def test_nonzero_bias_is_never_removed_or_converted():
    rewritten, _ = _check_equivalent(
        _conv_model(zero_bias=False, bias_value=0.5),
        {"dense_1x1_conv_to_matmul": 0, "zero_biases_removed": 0}, min_in_channels=8)
    assert _ops(rewritten) == ["Conv"] and len(rewritten.graph.node[0].input) == 3


def test_spatial_and_batched_convs_are_untouched():
    for kwargs in ({"kernel": 3}, {"batch": 2}, {"kernel": 3, "group": 8, "out_ch": 8}):
        rewritten, _ = _check_equivalent(
            _conv_model(**kwargs), {"dense_1x1_conv_to_matmul": 0, "grouped_1x1_conv_to_matmul": 0},
            min_in_channels=8)
        assert _ops(rewritten) == ["Conv"], kwargs


def test_grouped_1x1_becomes_batched_matmul_and_keeps_group_channel_order():
    for group, out_ch in ((2, 6), (4, 8), (8, 16)):
        model = _conv_model(in_ch=8, out_ch=out_ch, group=group, zero_bias=group != 4)
        rewritten, report = _check_equivalent(
            model, {"dense_1x1_conv_to_matmul": 0, "grouped_1x1_conv_to_matmul": 1,
                    "zero_biases_removed": int(group != 4)}, min_in_channels=8)
        assert _ops(rewritten) == ["Reshape", "MatMul", "Reshape"], group
        assert report["grouped_shapes_oc_ic_groups_h_w"] == [[out_ch, 8, group, 5, 5]]


def test_grouped_rewrite_can_be_disabled_independently():
    model = _conv_model(in_ch=8, out_ch=6, group=2)
    rewritten, _ = _check_equivalent(model, {"grouped_1x1_conv_to_matmul": 0, "zero_biases_removed": 1},
                                     min_in_channels=8, grouped_as_matmul=False)
    assert _ops(rewritten) == ["Conv"]
    rewritten, _ = _check_equivalent(_conv_model(in_ch=8, out_ch=6), {"dense_1x1_conv_to_matmul": 0},
                                     min_in_channels=8, dense_as_matmul=False)
    assert _ops(rewritten) == ["Conv"]


def test_bias_free_dense_1x1_converts_without_touching_bias_logic():
    rewritten, _ = _check_equivalent(
        _conv_model(zero_bias=False), {"dense_1x1_conv_to_matmul": 1, "zero_biases_removed": 0}, min_in_channels=8)
    assert _ops(rewritten) == ["Reshape", "MatMul", "Reshape"]


def _bundle(tmp_path, model, **manifest_overrides):
    bundle = tmp_path / "source"
    bundle.mkdir()
    onnx.save(model, str(bundle / "model.onnx"))
    sha = hashlib.sha256((bundle / "model.onnx").read_bytes()).hexdigest()
    manifest = {"manifest_version": 1, "precision": "fp32", "diagnostic_shape": False,
                "model_sha256": sha, "input_name": "x", "output_name": "y", **manifest_overrides}
    (bundle / "manifest.json").write_text(json.dumps(manifest))
    return bundle, sha


def test_derive_bundle_records_lineage_and_never_overwrites(tmp_path, capsys):
    bundle, source_sha = _bundle(tmp_path, _conv_model(in_ch=256, out_ch=8))
    out = tmp_path / "derived"
    assert onnx_rewrite.main(["--bundle", str(bundle), "--output", str(out), "--min-channels", "256"]) == 0
    manifest = json.loads((out / "manifest.json").read_text())
    new_sha = hashlib.sha256((out / "model.onnx").read_bytes()).hexdigest()
    assert manifest["model_sha256"] == new_sha != source_sha
    assert manifest["graph_rewrites"]["source_model_sha256"] == source_sha
    assert manifest["graph_rewrites"]["dense_1x1_conv_to_matmul"] == 1
    assert manifest["precision"] == "fp32"
    sums = dict(line.split("  ")[::-1] for line in (out / "SHA256SUMS.txt").read_text().splitlines())
    assert sums["model.onnx"] == new_sha
    # Source untouched, second run refuses to overwrite.
    assert hashlib.sha256((bundle / "model.onnx").read_bytes()).hexdigest() == source_sha
    assert onnx_rewrite.main(["--bundle", str(bundle), "--output", str(out)]) == 1
    assert not list(tmp_path.glob(".onnx-rewrite-*"))


def test_derive_can_record_a_new_tiling_halo(tmp_path):
    bundle, _ = _bundle(tmp_path, _conv_model(in_ch=256, out_ch=8),
                        tile=320, halo=64, retained_core=192)
    out = tmp_path / "derived"
    assert onnx_rewrite.main(["--bundle", str(bundle), "--output", str(out), "--halo", "40"]) == 0
    manifest = json.loads((out / "manifest.json").read_text())
    assert (manifest["tile"], manifest["halo"], manifest["retained_core"]) == (320, 40, 240)
    for bad in ("42", "160", "-4"):
        assert onnx_rewrite.main(["--bundle", str(bundle), "--output", str(tmp_path / f"bad{bad}"),
                                  "--halo", bad]) == 1


def test_derive_rejects_hash_mismatch_nothing_to_rewrite_and_non_fp32(tmp_path):
    bundle, _ = _bundle(tmp_path, _conv_model(in_ch=256, out_ch=8), model_sha256="0" * 64)
    assert onnx_rewrite.main(["--bundle", str(bundle), "--output", str(tmp_path / "a")]) == 1
    assert not (tmp_path / "a").exists()

    small = tmp_path / "small"
    small.mkdir()
    bundle, _ = _bundle(small, _conv_model(in_ch=8, out_ch=6, zero_bias=False))
    assert onnx_rewrite.main(["--bundle", str(bundle), "--output", str(tmp_path / "b")]) == 1

    half = tmp_path / "half"
    half.mkdir()
    bundle, _ = _bundle(half, _conv_model(in_ch=256, out_ch=8), precision="fp16")
    assert onnx_rewrite.main(["--bundle", str(bundle), "--output", str(tmp_path / "c")]) == 1
