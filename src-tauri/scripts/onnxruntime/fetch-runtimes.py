import base64
import gzip
import hashlib
import io
import json
import sys
import urllib.request
import zipfile
from pathlib import Path

ORT_VERSION = "1.24.4"
ORT_MACOS_VERSION = "1.23.2"
ORT_LINUX_VERSION = "1.25.1"
DIRECTML_VERSION = "1.15.4"
WEBGPU_EP_VERSION = "0.6.0"
NUGET = "https://api.nuget.org/v3"
HF_REPO = "CyberTimon/RapidRAW-Models"
HF_FOLDER = f"onnxruntimes-v{ORT_VERSION}"

ORT = ("Microsoft.ML.OnnxRuntime", ORT_VERSION)
ORT_MACOS = ("Microsoft.ML.OnnxRuntime", ORT_MACOS_VERSION)
ORT_LINUX = ("Microsoft.ML.OnnxRuntime", ORT_LINUX_VERSION)
ORT_DIRECTML = ("Microsoft.ML.OnnxRuntime.DirectML", ORT_VERSION)
DIRECTML = ("Microsoft.AI.DirectML", DIRECTML_VERSION)
WEBGPU_EP = ("Microsoft.ML.OnnxRuntime.EP.WebGpu", WEBGPU_EP_VERSION)

RUNTIMES = [
    ("windows", "x86_64", ORT_DIRECTML, "runtimes/win-x64/native/onnxruntime.dll",
     "onnxruntime-directml-windows-x86_64.dll", "onnxruntime.dll"),
    ("windows", "x86_64", DIRECTML, "bin/x64-win/DirectML.dll",
     "directml-windows-x86_64.dll", "DirectML.dll"),
    ("windows", "aarch64", ORT_DIRECTML, "runtimes/win-arm64/native/onnxruntime.dll",
     "onnxruntime-directml-windows-aarch64.dll", "onnxruntime.dll"),
    ("windows", "aarch64", DIRECTML, "bin/arm64-win/DirectML.dll",
     "directml-windows-aarch64.dll", "DirectML.dll"),
    ("linux", "x86_64", ORT_LINUX, "runtimes/linux-x64/native/libonnxruntime.so",
     f"libonnxruntime-{ORT_LINUX_VERSION}-linux-x86_64.so", "libonnxruntime.so"),
    ("linux", "x86_64", WEBGPU_EP, "runtimes/linux-x64/native/libonnxruntime_providers_webgpu.so",
     "libonnxruntime-providers-webgpu-linux-x86_64.so", "libonnxruntime_providers_webgpu.so"),
    ("linux", "aarch64", ORT_LINUX, "runtimes/linux-arm64/native/libonnxruntime.so",
     f"libonnxruntime-{ORT_LINUX_VERSION}-linux-aarch64.so", "libonnxruntime.so"),
    ("linux", "aarch64", WEBGPU_EP, "runtimes/linux-arm64/native/libonnxruntime_providers_webgpu.so",
     "libonnxruntime-providers-webgpu-linux-aarch64.so", "libonnxruntime_providers_webgpu.so"),
    ("macos", "x86_64", ORT_MACOS, "runtimes/osx-x64/native/libonnxruntime.dylib",
     "libonnxruntime-macos-x86_64.dylib", "libonnxruntime.dylib"),
    ("macos", "aarch64", ORT_MACOS, "runtimes/osx-arm64/native/libonnxruntime.dylib",
     "libonnxruntime-macos-aarch64.dylib", "libonnxruntime.dylib"),
    ("android", "aarch64", ORT, "runtimes/android/native/onnxruntime.aar!jni/arm64-v8a/libonnxruntime.so",
     "libonnxruntime-android-arm64-v8a.so", "libonnxruntime.so"),
]


def fetch_json(url):
    with urllib.request.urlopen(url) as response:
        data = response.read()
        if response.headers.get("Content-Encoding") == "gzip":
            data = gzip.decompress(data)
    return json.loads(data)


def sha512_base64(path):
    digest = hashlib.sha512()
    with open(path, "rb") as file:
        for chunk in iter(lambda: file.read(1 << 20), b""):
            digest.update(chunk)
    return base64.b64encode(digest.digest()).decode()


def download_package(package, cache):
    name, version = package
    lower = name.lower()
    entry = fetch_json(f"{NUGET}/registration5-gz-semver2/{lower}/{version}.json")
    catalog = fetch_json(entry["catalogEntry"])
    if catalog["packageHashAlgorithm"] != "SHA512":
        sys.exit(f"NuGet publishes a {catalog['packageHashAlgorithm']} hash for {name} {version}.")
    path = cache / f"{lower}.{version}.nupkg"
    if path.exists() and sha512_base64(path) == catalog["packageHash"]:
        return path
    print(f"Downloading {name} {version}")
    urllib.request.urlretrieve(f"{NUGET}-flatcontainer/{lower}/{version}/{lower}.{version}.nupkg", path)
    if sha512_base64(path) != catalog["packageHash"]:
        path.unlink()
        sys.exit(f"{name} {version} does not match the SHA-512 hash NuGet publishes.")
    return path


def extract(archive, member):
    outer, *inner = member.split("!")
    with zipfile.ZipFile(archive) as package:
        data = package.read(outer)
    for part in inner:
        data = zipfile.ZipFile(io.BytesIO(data)).read(part)
    return data


def rust_arms(entries):
    arms = []
    for target in dict.fromkeys(entry[:2] for entry in entries):
        files = [entry[2:] for entry in entries if entry[:2] == target]
        head = f'        ("{target[0]}", "{target[1]}") => vec!['
        if len(files) == 1:
            arms.append(head + "(\n" + "".join(f'            "{value}",\n' for value in files[0]) + "        )],")
        else:
            body = "".join(
                "            (\n" + "".join(f'                "{value}",\n' for value in file) + "            ),\n"
                for file in files
            )
            arms.append(head + "\n" + body + "        ],")
    return "\n".join(arms)


def main():
    root = Path(__file__).resolve().parents[3]
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "hf-upload" / HF_FOLDER
    cache = out.parent / "packages"
    out.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)

    packages = {package: download_package(package, cache) for package in dict.fromkeys(entry[2] for entry in RUNTIMES)}
    entries = []
    for system, arch, package, member, upload, library in RUNTIMES:
        data = extract(packages[package], member)
        (out / upload).write_bytes(data)
        entries.append((system, arch, upload, library, hashlib.sha256(data).hexdigest()))

    sums = "".join(f"{sha}  {upload}\n" for _, _, upload, _, sha in sorted(entries, key=lambda entry: entry[2]))
    (out / "SHA256SUMS").write_text(sums, newline="\n")

    print(f"\nUpload the files in {out} to the {HF_FOLDER} folder of https://huggingface.co/{HF_REPO}, for example with:")
    print(f'  hf upload {HF_REPO} "{out}" {HF_FOLDER}\n')
    print(sums)
    print("The match arms for runtime_libraries in src-tauri/build.rs:")
    print(rust_arms(entries))


if __name__ == "__main__":
    main()
