import numpy as np
import pytest
import torch
from rapidraw_denoise.raw import cfa_positions, pack, unpack
from rapidraw_denoise.inference import tiled_apply
from rapidraw_denoise.study.transforms import transform, inverse_transform
from rapidraw_denoise.noise import estimate_noise, synthesize, NoiseProfile
from rapidraw_denoise.vendor.nonlocalmf.sampling import reference_sampling


@pytest.mark.parametrize("pattern", [[[0,1],[3,2]],[[1,0],[2,3]],[[3,2],[0,1]],[[2,3],[1,0]]])
@pytest.mark.parametrize("shape",[(32,40),(33,41)])
def test_sensor_phase_and_edges_roundtrip(pattern,shape):
    mosaic=np.arange(np.prod(shape),dtype=np.float32).reshape(shape)
    positions=cfa_positions(pattern)
    assert np.array_equal(unpack(pack(mosaic,positions),positions,shape),mosaic)


def test_non_bayer_is_rejected():
    with pytest.raises(ValueError):cfa_positions(np.zeros((6,6),dtype=int))


@pytest.mark.parametrize("shape",[(4,13,17),(4,64,64),(4,73,91),(4,1,7)])
def test_tiling_has_complete_coverage_and_preserves_coordinates(shape):
    a=np.random.default_rng(42).normal(size=shape).astype(np.float32)
    assert np.array_equal(tiled_apply(a,lambda x:x,tile=32,halo=8),a)


def test_halo_matches_full_convolution_at_interior_seams():
    from scipy.ndimage import uniform_filter
    a=np.random.default_rng(42).normal(size=(4,93,91)).astype(np.float32)
    expected=uniform_filter(a,size=(1,7,7),mode="mirror")
    actual=tiled_apply(a,lambda x:uniform_filter(x,size=(1,7,7),mode="mirror"),tile=32,halo=8)
    np.testing.assert_allclose(actual,expected,atol=1e-7)


def test_transform_inverse_rectangular():
    x=np.arange(4*13*17).reshape(4,13,17)
    for i in range(8):assert np.array_equal(inverse_transform(transform(x,i),i),x)


def test_zero_offsets_equal_unfold():
    x=torch.randn(2,3,11,13)
    off=torch.zeros(2,18,11,13)
    actual=reference_sampling(x,off,(3,3),padding=(1,1))
    expected=torch.nn.functional.unfold(x,3,padding=1).reshape(2,27,11,13)
    torch.testing.assert_close(actual,expected,atol=3e-6,rtol=1e-5)


@pytest.mark.skipif(not torch.cuda.is_available(),reason="CUDA unavailable")
def test_cuda_operator_matches_independent_reference():
    ops=pytest.importorskip("deform_neighbourhood_sampling.ops")
    torch.manual_seed(93)
    x=torch.randn(1,3,31,35,device="cuda")
    offsets=torch.randn(1,18,31,35,device="cuda")*.3
    expected=reference_sampling(x,offsets,(3,3),padding=(1,1))
    actual=ops.deform_neighbourhood(x,offsets,(3,3),stride=1,padding=(1,1),dilation=1,offset_groups=1)
    torch.testing.assert_close(actual,expected,atol=2e-5,rtol=2e-4)


@pytest.mark.skipif(not torch.cuda.is_available(),reason="CUDA unavailable")
def test_cuda_training_gradients_match_reference():
    ops=pytest.importorskip("deform_neighbourhood_sampling.ops")
    torch.manual_seed(94)
    x=torch.randn(1,2,13,17,device="cuda",requires_grad=True)
    offsets=(torch.randn(1,18,13,17,device="cuda")*.3).requires_grad_()
    expected=reference_sampling(x,offsets,(3,3),padding=(1,1))
    actual=ops.deform_neighbourhood(x,offsets,(3,3),stride=1,padding=(1,1),dilation=1,offset_groups=1)
    weights=torch.randn_like(expected)
    expected_grad=torch.autograd.grad((expected*weights).sum(),(x,offsets))
    actual_grad=torch.autograd.grad((actual*weights).sum(),(x,offsets))
    for got,want in zip(actual_grad,expected_grad):
        torch.testing.assert_close(got,want,atol=8e-5,rtol=5e-4)


def test_estimator_recovers_known_signal_dependent_noise():
    levels=np.linspace(.035,.85,16,dtype=np.float32)
    clean=np.tile(np.repeat(levels,64)[None,:],(768,1))
    clean=np.stack([clean]*4)
    noisy=synthesize(clean,[.002]*4,[.00003]*4,seed=8)
    result=estimate_noise(noisy)
    np.testing.assert_allclose(result.shot,.002,rtol=.16)
    # The intercept is more weakly identified than the slope; assess variance
    # at dark and bright signals as well as the fitted physical parameters.
    for value in [.05,.4,.8]:
        np.testing.assert_allclose(np.array(result.shot)*value+result.read,.002*value+.00003,rtol=.16)


def test_invalid_noise_and_pixels_fail_closed():
    with pytest.raises(ValueError):NoiseProfile([0]*4,[-1]*4,[])
    with pytest.raises(ValueError):estimate_noise(np.ones((4,128,128)))
    with pytest.raises(RuntimeError):tiled_apply(np.ones((4,30,30)),lambda x:x*np.nan,tile=32,halo=8)


def test_real_pair_registration_and_input_derived_exposure():
    import json
    from scipy.ndimage import gaussian_filter
    from rapidraw_denoise.paired import register, exposure_fit
    clean=gaussian_filter(np.random.default_rng(92).uniform(.03,.55,(4,256,256)).astype(np.float32),sigma=(0,2,2))
    observed=np.roll(clean*1.2+.003,(2,-3),axis=(1,2))
    ref,obs,info=register(clean,observed)
    assert info["applied_integer_shift_yx"]==[-2,3]
    assert json.loads(json.dumps(info))["reference_origin_yx"] == [0,3]
    gain,offset,_=exposure_fit(ref,obs)
    np.testing.assert_allclose(gain,1.2,atol=1e-4)
    np.testing.assert_allclose(offset,.003,atol=1e-5)
    np.testing.assert_allclose((obs-offset)/gain,ref,atol=1e-6)
