use std::path::Path;

fn main() {
    let base_dir = Path::new(r"D:\neapdirbti");
    let mut cr2_files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(base_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(ext) = path.extension() {
                if ext.to_string_lossy().to_uppercase() == "CR2" {
                    cr2_files.push(path.to_string_lossy().to_string());
                }
            }
        }
    }
    cr2_files.sort();
    println!("Total CR2 files found: {}", cr2_files.len());

    let groups = rapidraw_lib::hdr_panorama::cluster_hdr_brackets(&cr2_files);
    println!("Total clustered groups found: {}", groups.len());
    for (i, g) in groups.iter().enumerate() {
        let first = Path::new(&g.paths[0]).file_name().unwrap().to_string_lossy();
        let last = Path::new(&g.paths[g.paths.len() - 1]).file_name().unwrap().to_string_lossy();
        if g.paths.len() >= 3 {
            println!("Group {:02}: {} files ({} -> {})", i, g.paths.len(), first, last);
            for p in &g.paths {
                let name = Path::new(p).file_name().unwrap().to_string_lossy();
                let meta = rapidraw_lib::exif_processing::load_primary_metadata(Path::new(p));
                let exp = meta.exif.as_ref().and_then(|e| e.get("ExposureTime")).cloned().unwrap_or_default();
                println!("    {} (exp: {})", name, exp);
            }
        }
    }
}
