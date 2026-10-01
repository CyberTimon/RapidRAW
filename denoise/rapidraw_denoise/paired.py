"""Real-pair diagnostics with frozen input-derived alignment and exposure.

These are approximate-reference measurements, not official RawNIND scores.
Integer packed-grid registration avoids interpolating Bayer samples. Residual
subpixel motion, low-ISO noise and exposure mismatch remain reported limits.
"""
import argparse
import json
from pathlib import Path
import shutil
import numpy as np
from scipy.ndimage import gaussian_filter
from skimage.registration import phase_cross_correlation
from .raw import RawFrame, sha256
from .inference import load_model, denoise
from .noise import estimate_noise
from .benchmark import metrics


def register(reference, observed, max_shift=8):
    if reference.shape != observed.shape:
        raise ValueError("Real pairs must have identical sensor dimensions")
    def proxy(x):
        return np.sqrt(np.maximum(gaussian_filter(x[[1,3]].mean(0), 2), 0))
    ref, obs = proxy(reference), proxy(observed)
    shift, _, _ = phase_cross_correlation(ref, obs, upsample_factor=10, normalization=None)
    if np.max(np.abs(shift)) > max_shift:
        raise ValueError(f"Pair exceeds translation limit: {shift.tolist()}")
    dy, dx = np.rint(shift).astype(int)
    h, w = ref.shape
    ry, rx = max(0, dy), max(0, dx)
    oy, ox = max(0, -dy), max(0, -dx)
    shape = h-abs(dy), w-abs(dx)
    clean = reference[:,ry:ry+shape[0],rx:rx+shape[1]]
    noisy = observed[:,oy:oy+shape[0],ox:ox+shape[1]]
    return clean, noisy, {"estimated_shift_packed_yx":shift.tolist(),
        "applied_integer_shift_yx":[int(dy),int(dx)],
        "remaining_fractional_shift_yx":(shift-[dy,dx]).tolist(),
        "reference_origin_yx":[int(ry),int(rx)],"observed_origin_yx":[int(oy),int(ox)]}


def exposure_fit(reference, observed):
    """Fit observed = gain * reference + offset using smoothed input only."""
    gains, offsets, residuals = [], [], []
    for target, source in zip(reference, observed):
        x = gaussian_filter(target, 3)[::8,::8].ravel()
        y = gaussian_filter(source, 3)[::8,::8].ravel()
        valid = (x > .005) & (x < .85) & (y > .005) & (y < .85)
        if valid.sum() < 256 or np.ptp(x[valid]) < .025:
            raise ValueError("Insufficient unsaturated range for real-pair exposure fit")
        x,y=x[valid],y[valid]
        design=np.stack([x,np.ones_like(x)],1).astype(np.float64)
        weight=np.ones_like(x)
        for _ in range(6):
            fit=np.linalg.lstsq(design*weight[:,None]**.5,y*weight**.5,rcond=None)[0]
            error=y-design@fit
            scale=max(float(np.median(np.abs(error-np.median(error)))*1.4826),1e-6)
            weight=np.minimum(1,1.5*scale/np.maximum(np.abs(error),1e-9))
        if not .25 < fit[0] < 4 or abs(fit[1]) > .02:
            raise ValueError(f"Unreliable real-pair photometric fit: {fit.tolist()}")
        gains.append(float(fit[0]));offsets.append(float(fit[1]));residuals.append(scale)
    return np.array(gains,dtype=np.float32)[:,None,None], np.array(offsets,dtype=np.float32)[:,None,None], residuals


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--manifest",required=True,type=Path);p.add_argument("--data",required=True,type=Path)
    p.add_argument("--checkpoint",required=True,type=Path);p.add_argument("--output",required=True,type=Path)
    p.add_argument("--split",choices=["validation","test"],default="validation")
    a=p.parse_args()
    a.output.parent.mkdir(parents=True,exist_ok=True)
    if shutil.disk_usage(a.output.parent).free < 21*1024**3:
        raise OSError("Real-pair diagnostics require a 20 GiB reserve plus output allowance")
    a.output.mkdir()
    manifest=json.loads(a.manifest.read_text());model=load_model(a.checkpoint)
    report={"complete":False,"split":a.split,"checkpoint_sha256":sha256(a.checkpoint),
        "protocol":"Approximate real reference: integer packed-grid translation; robust input-derived exposure/offset reused for all outputs. No subpixel resampling, no official benchmark or commercial claim. Upstream pretraining overlap unknown.","records":[]}
    for entry in manifest["files"]:
        if entry["role"] != "noisy" or entry["split"] != a.split:continue
        ground=next(f for f in manifest["files"] if f["scene"]==entry["scene"] and f["role"]=="clean")
        clean_frame=RawFrame(a.data/ground["filename"]);noisy_frame=RawFrame(a.data/entry["filename"])
        try:
            if clean_frame.positions != noisy_frame.positions:
                raise ValueError("Pair has incompatible Bayer phases")
            clean,noisy,alignment=register(clean_frame.packed,noisy_frame.packed)
            gain,offset,residual=exposure_fit(clean,noisy)
            profile=estimate_noise(noisy_frame.packed)
            _,h,w=clean.shape
            for i,(fy,fx) in enumerate([(.28,.28),(.65,.65)]):
                size=384;y=int((h-size)*fy)//4*4;x=int((w-size)*fx)//4*4
                ref=clean[:,y:y+size,x:x+size].copy()
                obs=noisy[:,y:y+size,x:x+size].copy()
                out,info=denoise(obs,model,profile,tile=320,halo=40)
                normalized=(out-offset)/gain;input_normalized=(obs-offset)/gain
                record={"scene":entry["scene"],"crop":i,"alignment":alignment,
                    "photometric_gain":gain.ravel().tolist(),"photometric_offset":offset.ravel().tolist(),
                    "smoothed_photometric_residual_mad":residual,"region_after_alignment":[x,y,size,size],
                    "reference_sha256":sha256(a.data/ground["filename"]),"source_sha256":sha256(a.data/entry["filename"]),
                    "input":metrics(ref,input_normalized),"output":metrics(ref,normalized),"inference":info}
                report["records"].append(record)
                np.savez_compressed(a.output/f'{entry["scene"]}-{i}.npz',reference=ref,observed=input_normalized,denoised=normalized)
                print(json.dumps({"scene":entry["scene"],"crop":i,"input_psnr":record["input"]["psnr"],"output_psnr":record["output"]["psnr"],"alignment":alignment}),flush=True)
                (a.output/"results.json").write_text(json.dumps(report,indent=2)+"\n")
        finally:
            clean_frame.close();noisy_frame.close()
    report["complete"]=True
    (a.output/"results.json").write_text(json.dumps(report,indent=2)+"\n")


if __name__=="__main__":main()
