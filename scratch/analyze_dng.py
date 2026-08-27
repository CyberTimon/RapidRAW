import os
import struct
import numpy as np
from PIL import Image

def analyze_tiff_dng(path):
    print("="*70)
    print(f"ANALYZING DNG: {path}")
    print(f"File size: {os.path.getsize(path):,} bytes")
    
    with open(path, "rb") as f:
        header = f.read(8)
        endian, magic, ifd_offset = struct.unpack("<2sHI", header)
        print(f"TIFF Header: Endian={endian}, Magic={magic}, IFD0 Offset={ifd_offset}")
        
        f.seek(ifd_offset)
        num_entries = struct.unpack("<H", f.read(2))[0]
        print(f"IFD0 Entries count: {num_entries}")
        
        tags = {}
        for _ in range(num_entries):
            tag_bytes = f.read(12)
            tag, ftype, count, val_or_offset = struct.unpack("<HHII", tag_bytes)
            tags[tag] = (ftype, count, val_or_offset)
            
        print("\n--- Parsed IFD0 Tags ---")
        tag_names = {
            254: "NewSubfileType",
            256: "ImageWidth",
            257: "ImageLength",
            258: "BitsPerSample",
            259: "Compression",
            262: "PhotometricInterpretation",
            270: "ImageDescription",
            271: "Make",
            272: "Model",
            273: "StripOffsets",
            274: "Orientation",
            277: "SamplesPerPixel",
            278: "RowsPerStrip",
            279: "StripByteCounts",
            282: "XResolution",
            283: "YResolution",
            284: "PlanarConfiguration",
            296: "ResolutionUnit",
            305: "Software",
            339: "SampleFormat",
            50706: "DNGVersion",
            50707: "DNGBackwardVersion",
            50708: "UniqueCameraModel",
            50721: "ColorMatrix1",
            50722: "ColorMatrix2",
            50727: "AnalogBalance",
            50728: "AsShotNeutral",
            50730: "BaselineExposure",
            50778: "CalibrationIlluminant1",
            50779: "CalibrationIlluminant2",
            50738: "LinearizationTable",
            50710: "CFAPattern",
            50711: "CFAPlaneColor",
            50712: "CFALayout",
            50713: "LinearizationTable",
            50714: "BlackLevelRepeatDim",
            50715: "BlackLevel",
            50717: "WhiteLevel",
            50718: "DefaultScale",
            50719: "DefaultCropOrigin",
            50720: "DefaultCropSize",
            50735: "NoiseProfile",
        }
        
        for t, (ftype, count, val_or_offset) in tags.items():
            name = tag_names.get(t, f"Tag_{hex(t)} ({t})")
            val_str = f"type={ftype}, count={count}, val/offset={val_or_offset}"
            
            # If offset points to extra data, read it
            if count * 4 > 4 or ftype in [2, 5, 10]:
                cur_pos = f.tell()
                f.seek(val_or_offset)
                if ftype == 2: # ASCII
                    ascii_val = f.read(count).decode(errors="ignore").strip('\x00')
                    val_str += f" -> ASCII: '{ascii_val}'"
                elif ftype == 5: # Rational (2x u32)
                    rats = []
                    for _ in range(count):
                        num, den = struct.unpack("<II", f.read(8))
                        rats.append(f"{num}/{den} ({num/den if den!=0 else 'inf'})")
                    val_str += f" -> Rational: {rats}"
                elif ftype == 10: # SRational (2x i32)
                    srats = []
                    for _ in range(count):
                        num, den = struct.unpack("<ii", f.read(8))
                        srats.append(f"{num}/{den} ({num/den if den!=0 else 'inf'})")
                    val_str += f" -> SRational: {srats}"
                elif ftype == 3 and count > 2: # SHORT array
                    shorts = struct.unpack(f"<{count}H", f.read(count * 2))
                    val_str += f" -> Shorts: {shorts}"
                elif ftype == 1 and count <= 4: # BYTE array
                    bvals = struct.unpack(f"<{count}B", f.read(count))
                    val_str += f" -> Bytes: {bvals}"
                f.seek(cur_pos)
            print(f"  {name:30s}: {val_str}")
            
        # Read raw pixel buffer
        width = tags.get(256)[2]
        height = tags.get(257)[2]
        samples = tags.get(277)[2] if 277 in tags else 3
        strip_offset = tags.get(273)[2]
        strip_bytes = tags.get(279)[2]
        sample_format = tags.get(339)[2] if 339 in tags else 1
        
        print(f"\nDimensions: {width} x {height}, Samples={samples}, Format={sample_format}")
        print(f"Strip Offset: {strip_offset}, Strip Bytes: {strip_bytes}")
        
        f.seek(strip_offset)
        raw_bytes = f.read(width * height * samples * 4) # 32-bit float
        
        arr = np.frombuffer(raw_bytes, dtype=np.float32).reshape((height, width, samples))
        print("\n--- Pixel Value Statistics (Linear 32-bit Float) ---")
        print(f"Shape: {arr.shape}, dtype: {arr.dtype}")
        print(f"Global Min: {arr.min():.6f}, Max: {arr.max():.6f}, Mean: {arr.mean():.6f}, Median: {np.median(arr):.6f}, Std: {arr.std():.6f}")
        
        for c, cname in enumerate(["Red", "Green", "Blue"]):
            ch = arr[:, :, c]
            p0, p1, p5, p25, p50, p75, p95, p99, p999, p100 = np.percentile(ch, [0, 1, 5, 25, 50, 75, 95, 99, 99.9, 100])
            print(f"  Channel {cname:5s}: min={p0:.6f}, 1%={p1:.6f}, 5%={p5:.6f}, 50%={p50:.6f}, 95%={p95:.6f}, 99%={p99:.6f}, 99.9%={p999:.6f}, max={p100:.6f}, mean={ch.mean():.6f}")
            
        neg_count = np.sum(arr < 0)
        zero_count = np.sum(arr == 0)
        nan_count = np.sum(np.isnan(arr))
        inf_count = np.sum(np.isinf(arr))
        clipped_high = np.sum(arr >= 1.0)
        print(f"\nAnomalies: NaNs={nan_count}, Infs={inf_count}, Negative values={neg_count} ({neg_count/arr.size*100:.2f}%), Exact Zeros={zero_count} ({zero_count/arr.size*100:.2f}%), >=1.0={clipped_high} ({clipped_high/arr.size*100:.2f}%)")
        
        # Save preview
        gamma_arr = np.clip(arr, 0, 1) ** (1/2.2) * 255.0
        gamma_uint8 = gamma_arr.astype(np.uint8)
        
        img_preview = Image.fromarray(gamma_uint8)
        img_preview.thumbnail((2000, 2000))
        img_preview.save("scratch/dng_preview_small.jpg", quality=90)
        
        h, w, _ = arr.shape
        sky_crop = Image.fromarray(gamma_uint8[int(h*0.2):int(h*0.4), int(w*0.4):int(w*0.6)])
        sky_crop.save("scratch/crop_sky.jpg", quality=95)
        
        horizon_crop = Image.fromarray(gamma_uint8[int(h*0.5):int(h*0.7), int(w*0.4):int(w*0.6)])
        horizon_crop.save("scratch/crop_horizon.jpg", quality=95)
        
        ground_crop = Image.fromarray(gamma_uint8[int(h*0.75):int(h*0.95), int(w*0.4):int(w*0.6)])
        ground_crop.save("scratch/crop_ground.jpg", quality=95)
        
        print("\nSaved preview images in scratch/ directory.")

analyze_tiff_dng("D:\\neapdirbti\\IMG_5035_Hdr.dng")
