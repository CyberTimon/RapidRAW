pub fn is_incamera_multiexposure_canon(file_bytes: &[u8]) -> bool {
    assert!(file_bytes.len() >= 8, "CR2 file must be at least 8 bytes");

    match file_bytes.get(0..4) {
        Some([0x49, 0x49, 0x2A, 0x00]) => {}
        _ => return false,
    }

    let walk = || -> Option<bool> {
        let b: [u8; 4] = file_bytes.get(4..8)?.try_into().ok()?;
        let ifd0_offset = u32::from_le_bytes(b) as usize;
        let exif_ifd_offset = _find_ifd_entry(file_bytes, ifd0_offset, 0x8769)? as usize;
        let maker_note_offset = _find_ifd_entry(file_bytes, exif_ifd_offset, 0x927C)? as usize;
        let multi_exp_block_offset =
            _find_ifd_entry(file_bytes, maker_note_offset, 0x4021)? as usize;
        let flag_offset = multi_exp_block_offset + 4;
        let v: [u8; 4] = file_bytes
            .get(flag_offset..flag_offset + 4)?
            .try_into()
            .ok()?;
        Some(u32::from_le_bytes(v) == 1)
    };

    walk().unwrap_or(false)
}

fn _find_ifd_entry(file_bytes: &[u8], ifd_offset: usize, tag_id: u16) -> Option<u32> {
    let rd16 = |offset: usize| -> Option<u16> {
        let b: [u8; 2] = file_bytes.get(offset..offset + 2)?.try_into().ok()?;
        Some(u16::from_le_bytes(b))
    };

    let rd32 = |offset: usize| -> Option<u32> {
        let b: [u8; 4] = file_bytes.get(offset..offset + 4)?.try_into().ok()?;
        Some(u32::from_le_bytes(b))
    };

    let entry_count = rd16(ifd_offset)? as usize;
    let capped_count = entry_count.min(512);

    for i in 0..capped_count {
        let entry_offset = ifd_offset + 2 + i * 12;
        let tag = rd16(entry_offset)?;

        if tag == tag_id {
            return rd32(entry_offset + 8);
        }
    }

    None
}

pub fn neutralize_wb_if_multiexposure(wb_coeffs: [f32; 4], file_bytes: &[u8]) -> [f32; 4] {
    if is_incamera_multiexposure_canon(file_bytes) {
        log::info!("[raw_hdr_wb] multi-exposure CR2 detected, neutralizing WB");
        let mut neutralized = wb_coeffs;
        for exp in &mut neutralized {
            if exp.is_finite() {
                *exp = 1.0;
            }
        }
        neutralized
    } else {
        wb_coeffs
    }
}
