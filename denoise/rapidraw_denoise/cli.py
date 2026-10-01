import argparse
import json
import os
from pathlib import Path
import shutil
import tempfile
import numpy as np
from PIL import Image
from .raw import RawFrame, save_render, sha256
from .noise import NoiseProfile
from .inference import denoise, load_model


def main():
    p=argparse.ArgumentParser(description="Experimental GPU RAW denoise; retains the existing RapidRAW AI option")
    p.add_argument("source",type=Path)
    p.add_argument("--output",required=True,type=Path,help="New output directory; existing directories are never overwritten")
    p.add_argument("--checkpoint",required=True,type=Path)
    p.add_argument("--device",choices=["cuda","cpu"],default="cuda")
    p.add_argument("--tile",type=int,default=256)
    p.add_argument("--halo",type=int,default=40)
    p.add_argument("--pilot",action="store_true")
    p.add_argument("--noise-scale",type=float,default=1.)
    p.add_argument("--noise-profile",type=Path)
    args=p.parse_args()
    args.output=args.output.resolve()
    if args.output.exists():
        p.error("Output directory already exists")
    args.output.parent.mkdir(parents=True,exist_ok=True)
    if shutil.disk_usage(args.output.parent).free < 20*1024**3:
        p.error("At least 20 GiB free output-volume space is required")
    frame=RawFrame(args.source)
    source_metadata=frame.metadata()
    # Float RAW, diagnostics and two full 16-bit renders, including temporary IO.
    estimate=frame.packed.nbytes*3 + np.prod(frame.shape)*6*2
    if shutil.disk_usage(args.output.parent).free < estimate+20*1024**3:
        p.error("Insufficient space for estimated outputs plus 20 GiB reserve")
    profile=None
    if args.noise_profile:
        profile=NoiseProfile(**json.loads(args.noise_profile.read_text()))
    model=load_model(args.checkpoint,args.device)
    candidate,info=denoise(frame.packed,model,profile,args.tile,args.halo,args.noise_scale,args.pilot,
                                       progress=lambda x: print(json.dumps(x),flush=True))
    info.update(source_metadata)
    info.update({"checkpoint_sha256":sha256(args.checkpoint),"status":"experimental; commercial parity unverified",
                 "sampler":os.environ.get("RAPIDRAW_DENOISE_SAMPLER","reference"),
                 "estimated_output_bytes":int(estimate)})
    temporary=Path(tempfile.mkdtemp(prefix=".denoise-",dir=args.output.parent))
    try:
        np.save(temporary/"denoised-raw.npy",candidate,allow_pickle=False)
        for name,planes in [("original",None),("denoised",candidate)]:
            rgb=frame.render(planes)
            save_render(temporary/f"{name}.tiff",rgb)
            preview=Image.fromarray((rgb/257).round().astype(np.uint8))
            preview.save(temporary/f"{name}.png")
            preview.thumbnail((1800,1800))
            preview.save(temporary/f"{name}-preview.jpg",quality=95)
        frame.close()
        if sha256(args.source) != source_metadata["source_sha256"]:
            raise RuntimeError("Source changed during inference")
        info["artifacts"]={f.name:sha256(f) for f in temporary.iterdir()}
        (temporary/"manifest.json").write_text(json.dumps(info,indent=2)+"\n")
        temporary.rename(args.output)
    except BaseException:
        shutil.rmtree(temporary)
        raise
    print(json.dumps({"output":str(args.output),**info},indent=2))


if __name__ == "__main__":
    main()
