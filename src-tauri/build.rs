use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

fn verify_sha256(path: &Path, expected_hash: &str) -> Result<bool, io::Error> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 8192];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    let hash_bytes = hasher.finalize();
    let calculated_hash = hex::encode(hash_bytes);
    Ok(calculated_hash == expected_hash)
}

fn download_and_verify(
    url: &str,
    dest_path: &Path,
    expected_hash: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR not set"));
    let temp_filename = dest_path.file_name().unwrap();
    let temp_path = out_dir.join(temp_filename);

    println!(
        "cargo:warning=Downloading to temporary path: {:?}",
        temp_path
    );
    let mut response = reqwest::blocking::get(url)?;

    if !response.status().is_success() {
        let status = response.status();
        let error_body = response
            .text()
            .unwrap_or_else(|_| "Could not read error body".to_string());
        return Err(format!("Download failed with status {}: {}", status, error_body).into());
    }

    let mut temp_file = fs::File::create(&temp_path)?;
    response.copy_to(&mut temp_file)?;
    println!("cargo:warning=Download complete. Verifying file integrity...");

    match verify_sha256(&temp_path, expected_hash) {
        Ok(true) => {
            fs::copy(&temp_path, dest_path)?;
            fs::remove_file(&temp_path)?;
            println!(
                "cargo:warning=Successfully downloaded and verified {:?}.",
                dest_path
            );
            Ok(())
        }
        Ok(false) => {
            fs::remove_file(&temp_path)?;
            Err("Verification failed! The downloaded file is corrupt.".into())
        }
        Err(e) => {
            fs::remove_file(&temp_path).ok();
            Err(format!("Could not verify file after download: {}", e).into())
        }
    }
}

fn runtime_libraries(
    target_os: &str,
    target_arch: &str,
) -> Vec<(&'static str, &'static str, &'static str)> {
    match (target_os, target_arch) {
        ("windows", "x86_64") => vec![
            (
                "onnxruntime-directml-windows-x86_64.dll",
                "onnxruntime.dll",
                "e7eedec6a6f26dc39dc948276a75ef6d2bee3fff944d874ceed0bbd3b97bff40",
            ),
            (
                "directml-windows-x86_64.dll",
                "DirectML.dll",
                "9c9e6d822561c6c41b90e6994b3e8857cf1d66dbfb1e0c4c799c7c89b4e92da1",
            ),
        ],
        ("windows", "aarch64") => vec![
            (
                "onnxruntime-directml-windows-aarch64.dll",
                "onnxruntime.dll",
                "939fa0be435d253eadd9e394ee94ad6b6ac1878c83b64118bb4bda669eb0e28c",
            ),
            (
                "directml-windows-aarch64.dll",
                "DirectML.dll",
                "77b0db83ff903f2323f5caf538499d75af6038bbea23b7959f7d232d9a4ab9d4",
            ),
        ],
        ("linux", "x86_64") => vec![
            (
                "libonnxruntime-1.25.1-linux-x86_64.so",
                "libonnxruntime.so",
                "7a7c63fec274e9577477a0158a03a205e3ed9320b032a2df2b2a01b6ae1d3b94",
            ),
            (
                "libonnxruntime-providers-webgpu-linux-x86_64.so",
                "libonnxruntime_providers_webgpu.so",
                "5b711b9dcececc2d08ffb33d3847df4c7d24804c2d1ff93aa26d2d11891c9916",
            ),
        ],
        ("linux", "aarch64") => vec![
            (
                "libonnxruntime-1.25.1-linux-aarch64.so",
                "libonnxruntime.so",
                "e34095ad2791f1f05ed17324ede7873b4fdb4c136b3ba3f1dd5093d2e76d4192",
            ),
            (
                "libonnxruntime-providers-webgpu-linux-aarch64.so",
                "libonnxruntime_providers_webgpu.so",
                "f883094e682f385177cc1ff536005166d18dea8647daeb3d4ae0d030f0fce659",
            ),
        ],
        ("macos", "x86_64") => vec![(
            "libonnxruntime-macos-x86_64.dylib",
            "libonnxruntime.dylib",
            "8c9c78de65ea3786f987c0d980e9c1b13a3a5fbc6b3e2965ba05b450e6e4c054",
        )],
        ("macos", "aarch64") => vec![(
            "libonnxruntime-macos-aarch64.dylib",
            "libonnxruntime.dylib",
            "d306d2bc768540766c7ed8a1e0ff05d2870c77a934ebeee4a7bafa1b732ef299",
        )],
        ("android", "aarch64") => vec![(
            "libonnxruntime-android-arm64-v8a.so",
            "libonnxruntime.so",
            "7f2f5c400f70a70bc4dce907752c48e2691de5e70d4c08cff45639e0e98f480e",
        )],
        _ => panic!("Unsupported target: {}-{}", target_os, target_arch),
    }
}

fn copy_and_verify(
    source_path: &Path,
    dest_path: &Path,
    expected_hash: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    if !verify_sha256(source_path, expected_hash)? {
        return Err(format!("Local file {:?} has an incorrect hash.", source_path).into());
    }
    fs::copy(source_path, dest_path)?;
    println!(
        "cargo:warning=Copied and verified {:?} from {:?}.",
        dest_path, source_path
    );
    Ok(())
}

fn ensure_runtime_library(
    dest_dir: &Path,
    download_filename: &str,
    lib_name: &str,
    expected_hash: &str,
) -> PathBuf {
    let dest_path = dest_dir.join(lib_name);

    if dest_path.exists() {
        match verify_sha256(&dest_path, expected_hash) {
            Ok(true) => {
                println!(
                    "cargo:warning={} already exists and is valid. Skipping download.",
                    lib_name
                );
                return dest_path;
            }
            Ok(false) => {
                println!(
                    "cargo:warning=File {:?} exists but has incorrect hash. Deleting and re-downloading.",
                    dest_path
                );
                fs::remove_file(&dest_path).unwrap();
            }
            Err(e) => {
                println!(
                    "cargo:warning=Could not verify file {:?}: {}. Re-downloading.",
                    dest_path, e
                );
            }
        }
    }

    let local_path = env::var_os("RAPIDRAW_RUNTIME_DIR")
        .map(|dir| PathBuf::from(dir).join(download_filename))
        .filter(|path| path.exists());

    let result = if let Some(local_path) = local_path {
        copy_and_verify(&local_path, &dest_path, expected_hash)
    } else {
        println!("cargo:warning=Downloading {}...", download_filename);
        let base_url =
            "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/onnxruntimes-v1.24.4/";
        let download_url = format!("{}{}?download=true", base_url, download_filename);
        println!("cargo:warning=URL: {}", download_url);
        download_and_verify(&download_url, &dest_path, expected_hash)
    };

    if let Err(e) = result {
        panic!("Failed to download and verify {}: {}", lib_name, e);
    }

    dest_path
}

const FFMPEG_BASE_URL: &str =
    "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/ffmpeg-v9.0.2-lean/";
const FFMPEG_LIBRARIES: &[&str] = &[
    "avutil",
    "swresample",
    "swscale",
    "avcodec",
    "avformat",
    "avfilter",
];

fn ffmpeg_archive(target_os: &str, target_arch: &str) -> Option<(&'static str, &'static str)> {
    match (target_os, target_arch) {
        ("windows", "x86_64") => Some((
            "ffmpeg-windows-x86_64.zip",
            "8345e3e681a1929104d995d0cb7980b1fdb04a5f92ab064812e05d1c52f28e71",
        )),
        ("windows", "aarch64") => Some((
            "ffmpeg-windows-aarch64.zip",
            "b9bb8a9a39b1d1dfad8a5af80661ff556feaa672d4923984d234da6f7af2140a",
        )),
        ("linux", "x86_64") => Some((
            "ffmpeg-linux-x86_64.tar.xz",
            "267e0e55eac67ed2e130700e03bd68391364a3b2e735d7c19731b4b3c0464461",
        )),
        ("linux", "aarch64") => Some((
            "ffmpeg-linux-aarch64.tar.xz",
            "cc966e19104c6099d909522188de918c432cfd2e84907023672b2ec5eba5b071",
        )),
        ("macos", "aarch64") => Some((
            "ffmpeg-macos-aarch64.tar.gz",
            "ab486f973a777667b576efec138c4c5fb4794056b9147c400ced26e1936cec2c",
        )),
        ("macos", "x86_64") => Some((
            "ffmpeg-macos-x86_64.tar.gz",
            "9dd2fb60d684e569d5d40df5d85ef050b05f3e681bc351720206ca64e91a9f39",
        )),
        _ => None,
    }
}

fn is_ffmpeg_library(name: &str) -> bool {
    FFMPEG_LIBRARIES.iter().any(|library| {
        let windows = name.starts_with(&format!("{}-", library)) && name.ends_with(".dll");
        let linux =
            name.starts_with(&format!("lib{}.so.", library)) && name.matches('.').count() == 2;
        let macos = name.starts_with(&format!("lib{}.", library))
            && name.ends_with(".dylib")
            && name.matches('.').count() == 2;
        windows || linux || macos
    })
}

fn ensure_ffmpeg(target_os: &str, target_arch: &str, dest_dir: &Path) {
    let Some((archive_name, expected_hash)) = ffmpeg_archive(target_os, target_arch) else {
        return;
    };
    if expected_hash.is_empty() {
        println!(
            "cargo:warning={} has no published checksum yet, so this build has no video support.",
            archive_name
        );
        return;
    }
    let ffmpeg_dir = dest_dir.join("ffmpeg");
    let marker = ffmpeg_dir.join(".archive");
    if fs::read_to_string(&marker).is_ok_and(|content| content.trim() == expected_hash) {
        return;
    }
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR not set"));
    let archive_dir = out_dir.join("ffmpeg-archive");
    fs::create_dir_all(&archive_dir).unwrap();
    let archive_path = archive_dir.join(archive_name);
    let local_archive = env::var_os("RAPIDRAW_RUNTIME_DIR")
        .map(|dir| PathBuf::from(dir).join(archive_name))
        .filter(|path| path.exists());
    let result = match local_archive {
        Some(local) => copy_and_verify(&local, &archive_path, expected_hash),
        None if verify_sha256(&archive_path, expected_hash).unwrap_or(false) => Ok(()),
        None => {
            println!("cargo:warning=Downloading {}...", archive_name);
            download_and_verify(
                &format!("{}{}?download=true", FFMPEG_BASE_URL, archive_name),
                &archive_path,
                expected_hash,
            )
        }
    };
    if let Err(e) = result {
        panic!("Failed to download and verify {}: {}", archive_name, e);
    }

    let extract_dir = out_dir.join("ffmpeg-extract");
    let _ = fs::remove_dir_all(&extract_dir);
    fs::create_dir_all(&extract_dir).unwrap();
    let status = std::process::Command::new("tar")
        .arg("-xf")
        .arg(&archive_path)
        .arg("-C")
        .arg(&extract_dir)
        .status()
        .expect("failed to run tar to unpack FFmpeg");
    assert!(status.success(), "tar could not unpack {}", archive_name);

    let root = fs::read_dir(&extract_dir)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| path.is_dir())
        .expect("FFmpeg archive has no top-level folder");
    let _ = fs::remove_dir_all(&ffmpeg_dir);
    fs::create_dir_all(&ffmpeg_dir).unwrap();
    let library_dir = root.join(if target_os == "windows" { "bin" } else { "lib" });
    for entry in fs::read_dir(&library_dir).unwrap().filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_ffmpeg_library(&name) {
            fs::copy(entry.path(), ffmpeg_dir.join(&name)).unwrap();
        }
    }
    fs::copy(root.join("LICENSE.txt"), ffmpeg_dir.join("LICENSE.txt")).unwrap();
    fs::write(&marker, expected_hash).unwrap();
    let _ = fs::remove_dir_all(&extract_dir);
    println!(
        "cargo:warning=Unpacked the LGPL FFmpeg libraries to {:?}.",
        ffmpeg_dir
    );
}

fn main() {
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap();
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap();

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());

    let dest_dir = if target_os == "android" {
        manifest_dir.join("libs").join("arm64-v8a")
    } else {
        manifest_dir.join("resources")
    };

    fs::create_dir_all(&dest_dir).unwrap();

    let lib_paths: Vec<PathBuf> = runtime_libraries(&target_os, &target_arch)
        .into_iter()
        .map(|(download_filename, lib_name, expected_hash)| {
            ensure_runtime_library(&dest_dir, download_filename, lib_name, expected_hash)
        })
        .collect();

    ensure_ffmpeg(&target_os, &target_arch, &dest_dir);

    if target_os == "android" {
        let jni_libs_dir = manifest_dir.join("gen/android/app/src/main/jniLibs/arm64-v8a");
        fs::create_dir_all(&jni_libs_dir).unwrap();
        for lib_path in &lib_paths {
            fs::copy(lib_path, jni_libs_dir.join(lib_path.file_name().unwrap())).unwrap();
        }

        println!("cargo:rustc-env=ORT_LIB_PATH={}", dest_dir.display());
        println!("cargo:rustc-link-search=native={}", dest_dir.display());
    }

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=RAPIDRAW_RUNTIME_DIR");

    tauri_build::build()
}
