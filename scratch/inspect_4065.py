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

print("=== EXIF AUDIT OF CR2 SOURCE FILES (4065 to 4070) ===")
for i in range(4065, 4071):
    p = f'D:\\neapdirbti\\IMG_{i}.CR2'
    if os.path.exists(p):
        meta = parse_exif(p)
        print(f"IMG_{i}.CR2: Exp={meta.get('exp_time')} ({meta.get('exp_sec',0):.4f}s), Aperture=f/{meta.get('f_number')}, ISO={meta.get('iso')}, Focal={meta.get('focal')}mm, Time={meta.get('datetime')}")
    else:
        print(f"IMG_{i}.CR2: NOT FOUND")

print("\n=== PIXEL & ARTIFACT AUDIT OF IMG_4065_Pano_UltraHDR.jpg ===")
pano_path = r'D:\neapdirbti\IMG_4065_Pano_UltraHDR.jpg'
if os.path.exists(pano_path):
    img = Image.open(pano_path)
    arr = np.array(img)
    h, w, c = arr.shape
    print(f"Dimensions: {w}x{h}, Mode: {img.mode}, Channels: {c}")
    print(f"Global Min RGB: {arr.min(axis=(0,1))}")
    print(f"Global Max RGB: {arr.max(axis=(0,1))}")
    print(f"Global Mean RGB: {arr.mean(axis=(0,1))}")
    print(f"Global Median RGB: {np.median(arr, axis=(0,1))}")
    print(f"Percentiles 90%: {np.percentile(arr, 90, axis=(0,1))}, 99%: {np.percentile(arr, 99, axis=(0,1))}")
    
    # Check bottom half of image (shadows/void)
    bottom_half = arr[h//2:, :, :]
    print(f"Bottom 50% rows mean RGB: {bottom_half.mean(axis=(0,1))}")
    print(f"Bottom 25% rows mean RGB: {arr[3*h//4:, :, :].mean(axis=(0,1))}")
    
    # Check top right corner warp region
    top_right_warp = arr[:h//4, 3*w//4:, :]
    print(f"Top-right 25% corner mean RGB: {top_right_warp.mean(axis=(0,1))}")
    
    # Histogram distribution
    lum = 0.2126 * arr[:,:,0] + 0.7152 * arr[:,:,1] + 0.0722 * arr[:,:,2]
    under_2pct = (lum < 5.1).mean() * 100
    under_5pct = (lum < 12.75).mean() * 100
    under_10pct = (lum < 25.5).mean() * 100
    over_90pct = (lum > 229.5).mean() * 100
    print(f"\nHistogram distribution:")
    print(f"  Pixels in absolute black (<2% luminance): {under_2pct:.2f}%")
    print(f"  Pixels in extreme dark crush (<5% luminance): {under_5pct:.2f}%")
    print(f"  Pixels in dark shadow (<10% luminance): {under_10pct:.2f}%")
    print(f"  Pixels in highlight zone (>90% luminance): {over_90pct:.2f}%")
    
    with open(pano_path, 'rb') as f:
        content = f.read()
    soi_count = content.count(b'\xff\xd8')
    print('\nJPEG SOI markers count:', soi_count)
    has_xmp = b'<x:xmpmeta' in content
    print('Has XMP metadata:', has_xmp)
