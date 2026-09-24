import numpy as np
from PIL import Image

# Check crop images generated from IMG_5035_Hdr.dng
for name in ["scratch/dng_preview_small.jpg", "scratch/crop_sky.jpg", "scratch/crop_horizon.jpg", "scratch/crop_ground.jpg"]:
    im = Image.open(name)
    print(f"{name}: size={im.size}, mode={im.mode}")
    stat = np.array(im)
    print(f"   Min={stat.min()}, Max={stat.max()}, Mean={stat.mean():.2f}, Std={stat.std():.2f}")
