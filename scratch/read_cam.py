with open("D:\\neapdirbti\\IMG_5035.CR2", "rb") as f:
    f.seek(244)
    make = f.read(6).decode(errors="ignore")
    f.seek(250)
    model = f.read(14).decode(errors="ignore")
    f.seek(298)
    dt = f.read(20).decode(errors="ignore")
    print(f"Make: {make}, Model: {model}, DateTime: {dt}")
