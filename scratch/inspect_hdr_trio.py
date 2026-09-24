import os, struct
from PIL import Image
import numpy as np

def parse_exif(filepath):
    with open(filepath, 'rb') as f:
        data = f.read(65536)
    endian = '<' if data[:2] == b'II' else '>'
    ifd0_offset = struct.unpack_from(endian + 'I', data, 4)[0]
    num_entries = struct.unpack_from(endian + 'H', data, ifd0_offset)[0]
    offset = ifd0_offset + 2
    exif_offset = None
    for _ in range(num_entries):
        tag, typ, cnt, val = struct.unpack_from(endian + 'HHI4s', data, offset)
        offset += 12
        if tag == 0x8769:
            exif_offset = struct.unpack_from(endian + 'I', val, 0)[0]
            
    res = {}
    if exif_offset and exif_offset < len(data) - 2:
        num_exif = struct.unpack_from(endian + 'H', data, exif_offset)[0]
        ex_off = exif_offset + 2
        for _ in range(num_exif):
            if ex_off + 12 > len(data): break
            tag, typ, cnt, val = struct.unpack_from(endian + 'HHI4s', data, ex_off)
            ex_off += 12
            if tag == 0x829a: # ExposureTime
                v_off = struct.unpack_from(endian + 'I', val, 0)[0]
                if v_off + 8 <= len(data):
                    num, den = struct.unpack_from(endian + 'II', data, v_off)
                    res['exp_time'] = f"{num}/{den}" if den != 0 else str(num)
                    res['exp_sec'] = num / den if den != 0 else 0
            elif tag == 0x829d: # FNumber
                v_off = struct.unpack_from(endian + 'I', val, 0)[0]
                if v_off + 8 <= len(data):
                    num, den = struct.unpack_from(endian + 'II', data, v_off)
                    res['f_number'] = num / den if den != 0 else 0
            elif tag == 0x8827: # ISO
                res['iso'] = struct.unpack_from(endian + 'H', val, 0)[0]
            elif tag == 0x9003: # DateTimeOriginal
                v_off = struct.unpack_from(endian + 'I', val, 0)[0]
                if v_off + 20 <= len(data):
                    res['datetime'] = data[v_off:v_off+19].decode('latin1', 'ignore')
            elif tag == 0x920a: # FocalLength
                v_off = struct.unpack_from(endian + 'I', val, 0)[0]
                if v_off + 8 <= len(data):
                    num, den = struct.unpack_from(endian + 'II', data, v_off)
                    res['focal'] = num / den if den != 0 else 0
    return res

sets = [
    ("Set 1: IMG_4221_Hdr.jpg (Cyclist on Road)", range(4221, 4224), r"D:\neapdirbti\IMG_4221_Hdr.jpg"),
    ("Set 2: IMG_4164_Hdr.jpg (Macro Catkins / Bokeh)", range(4164, 4170), r"D:\neapdirbti\IMG_4164_Hdr.jpg"),
    ("Set 3: IMG_4224_Hdr.jpg (Moving Boat on River)", range(4224, 4227), r"D:\neapdirbti\IMG_4224_Hdr.jpg"),
]

for name, r, out_path in sets:
    print(f"\n=======================================================")
    print(f"=== {name} ===")
    print(f"=======================================================")
    for i in r:
        p = f'D:\\neapdirbti\\IMG_{i}.CR2'
        if os.path.exists(p):
            meta = parse_exif(p)
            print(f"IMG_{i}.CR2: Exp={meta.get('exp_time')} ({meta.get('exp_sec',0):.4f}s), Aperture=f/{meta.get('f_number')}, ISO={meta.get('iso')}, Focal={meta.get('focal')}mm, Time={meta.get('datetime')}")
    
    if os.path.exists(out_path):
        img = Image.open(out_path)
        arr = np.array(img)
        h, w, c = arr.shape
        lum = 0.2126 * arr[:,:,0] + 0.7152 * arr[:,:,1] + 0.0722 * arr[:,:,2]
        under_5pct = (lum < 12.75).mean() * 100
        under_10pct = (lum < 25.5).mean() * 100
        print(f"\nOutput Image {os.path.basename(out_path)}:")
        print(f"  Dimensions: {w}x{h}, Mode: {img.mode}")
        print(f"  Global Min RGB: {arr.min(axis=(0,1))}")
        print(f"  Global Max RGB: {arr.max(axis=(0,1))}")
        print(f"  Global Mean RGB: {arr.mean(axis=(0,1))} (Mean Lum: {lum.mean():.2f} / 255)")
        print(f"  Pixels in extreme dark crush (<5% lum): {under_5pct:.2f}%")
        print(f"  Pixels in dark shadow (<10% lum): {under_10pct:.2f}%")
        with open(out_path, 'rb') as f:
            content = f.read()
        soi_count = content.count(b'\xff\xd8')
        has_xmp = b'<x:xmpmeta' in content
        print(f"  JPEG SOI count: {soi_count}, Has XMP: {has_xmp}")
