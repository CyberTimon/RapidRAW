import struct
import os

def parse_cr2(path):
    print("="*70)
    print(f"CR2 FILE: {path} ({os.path.getsize(path):,} bytes)")
    with open(path, "rb") as f:
        data = f.read(2048)
        endian, magic, ifd0_offset = struct.unpack("<2sHI", data[:8])
        cr2_magic = data[8:12]
        print(f"Header: Endian={endian}, Magic={magic}, IFD0={ifd0_offset}, CR2 Magic={cr2_magic}")
        
        # Read IFD0 tags
        f.seek(ifd0_offset)
        num_entries = struct.unpack("<H", f.read(2))[0]
        print(f"IFD0 Entries: {num_entries}")
        for _ in range(num_entries):
            tag_bytes = f.read(12)
            tag, ftype, count, val_or_offset = struct.unpack("<HHII", tag_bytes)
            if tag in [0x010F, 0x0110, 0x0131, 0x0132, 0x8769]:
                print(f"  Tag 0x{tag:04X}: type={ftype}, count={count}, val/offset={val_or_offset}")

parse_cr2("D:\\neapdirbti\\IMG_5035.CR2")
parse_cr2("D:\\neapdirbti\\IMG_5036.CR2")
