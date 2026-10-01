"""Controlled-corruption evaluation; never presented as a commercial benchmark."""
import argparse
import json
from pathlib import Path
import shutil
import numpy as np
from scipy.ndimage import sobel
from .raw import RawFrame, sha256
from .noise import NoiseProfile, synthesize, estimate_noise
from .inference import load_model, denoise


def metrics(reference, prediction):
    error=prediction.astype(np.float64)-reference
    mse=float(np.mean(error**2))
    gradient=np.hypot(sobel(reference,axis=1),sobel(reference,axis=2))
    edges=gradient >= np.quantile(gradient,.8)
    flat=gradient <= np.quantile(gradient,.2)
    exposure=min(64., .8/max(float(np.quantile(reference,.99)),.0125))
    display_reference=np.maximum(reference*exposure,0)**(1/2.4)
    display_prediction=np.maximum(prediction*exposure,0)**(1/2.4)
    display_mse=float(np.mean((display_prediction-display_reference)**2))
    return {"psnr":float(-10*np.log10(max(mse,1e-15))),
            "exposure_normalized_gamma_psnr":float(-10*np.log10(max(display_mse,1e-15))),
            "evaluation_exposure":exposure,
            "edge_psnr":float(-10*np.log10(max(float(np.mean(error[edges]**2)),1e-15))),
            "flat_rmse":float(np.sqrt(np.mean(error[flat]**2))),
            "channel_bias":error.mean((1,2)).tolist()}


def cases(manifest, directory, split, size=384):
    data=json.loads(Path(manifest).read_text())
    for entry in data["files"]:
        if entry["role"]!="clean" or entry["split"]!=split:continue
        frame=RawFrame(Path(directory)/entry["filename"])
        image=frame.packed
        _,h,w=image.shape
        for index,(fy,fx) in enumerate([(.28,.28),(.65,.65)]):
            y=int((h-size)*fy)//4*4;x=int((w-size)*fx)//4*4
            clean=np.clip(image[:,y:y+size,x:x+size],0,1).copy()
            yield {"scene":entry["scene"],"crop":index,"packed_region":[x,y,size,size],
                   "source_sha256":sha256(Path(directory)/entry["filename"])},clean
        frame.close()


def main():
    p=argparse.ArgumentParser();p.add_argument("--manifest",required=True);p.add_argument("--data",required=True)
    p.add_argument("--checkpoint",required=True);p.add_argument("--output",required=True,type=Path)
    p.add_argument("--split",choices=["validation","test"],default="validation")
    p.add_argument("--ablations",action="store_true")
    p.add_argument("--row-ablation",action="store_true")
    a=p.parse_args()
    if a.output.exists():raise FileExistsError(a.output)
    a.output.parent.mkdir(parents=True,exist_ok=True)
    if shutil.disk_usage(a.output.parent).free < 21*1024**3:
        raise OSError("Benchmark requires a 20 GiB reserve plus output allowance")
    a.output.mkdir(parents=True)
    model=load_model(a.checkpoint)
    records=[]
    for case_index,(case,clean) in enumerate(cases(a.manifest,a.data,a.split)):
        for corruption,shot,read,row,bias in [("shot-read",.003,3e-5,0.,0.),("structured",.008,8e-5,.0015,.0005)]:
            noisy=synthesize(clean,[shot]*4,[read]*4,seed=19000+case_index,row_sigma=row,black_bias=bias)
            oracle=NoiseProfile([shot]*4,[read]*4,[],method="synthetic-oracle-upper-reference")
            estimated=estimate_noise(noisy)
            variants=[("blind",estimated,False)]
            if a.ablations:variants += [("oracle",oracle,False),("pilot",estimated,True)]
            if a.row_ablation:variants += [("row-corrected",estimated,False)]
            base={**case,"corruption":corruption,"noise":{"shot":shot,"read":read,"row_sigma":row,"black_bias":bias},
                  "input":metrics(clean,noisy)}
            for name,profile,pilot in variants:
                output,info=denoise(noisy,model,profile,tile=320,halo=40,pilot=pilot,row_correction=name=="row-corrected")
                record={**base,"variant":name,"output":metrics(clean,output),"inference":info}
                records.append(record)
                artifact=a.output/f'{case["scene"]}-{case["crop"]}-{corruption}-{name}.npz'
                np.savez_compressed(artifact,clean=clean,noisy=noisy,denoised=output)
                print(json.dumps({"scene":case["scene"],"crop":case["crop"],"noise":corruption,"variant":name,"psnr":record["output"]["psnr"]}),flush=True)
                (a.output/"results.json").write_text(json.dumps({"checkpoint_sha256":sha256(a.checkpoint),
                    "protocol":"Controlled corruption of low-ISO RAW. Scene split applies to our adaptation; upstream pretraining overlap unknown. No commercial parity claim.",
                    "split":a.split,"complete":False,"records":records},indent=2)+"\n")
    summary=json.loads((a.output/"results.json").read_text());summary["complete"]=True
    (a.output/"results.json").write_text(json.dumps(summary,indent=2)+"\n")


if __name__=="__main__":main()
