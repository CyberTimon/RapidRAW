use moxcms::ColorProfile;

#[derive(Debug, Clone, Default)]
pub struct HeifMetadata {
    pub icc_profile: Option<Vec<u8>>,
    pub cicp: Option<CicpInfo>,
    pub exif: Option<Vec<u8>>,
    pub bit_depth: Option<u8>,
    pub primary_item_id: Option<u32>,
    pub ispe_width: Option<u32>,
    pub ispe_height: Option<u32>,
    pub irot: Option<u8>,
    pub imir: Option<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CicpInfo {
    pub color_primaries: u16,
    pub transfer_characteristics: u16,
    pub matrix_coefficients: u16,
    pub full_range: bool,
}

impl CicpInfo {
    pub fn to_moxcms_profile(&self) -> Option<ColorProfile> {
        match self.color_primaries {
            12 | 11 => Some(ColorProfile::new_display_p3()), // Display P3 / DCI-P3
            9 => Some(ColorProfile::new_bt2020()),          // Rec.2020
            1 => Some(ColorProfile::new_srgb()),            // BT.709 / sRGB
            _ => None,
        }
    }
}

impl HeifMetadata {
    /// Returns the effective EXIF orientation (1..=8) if transformative properties (irot/imir)
    /// are present in the ISOBMFF container.
    ///
    /// Per ISO/IEC 23008-12 Section 6.5.10 (irot):
    /// `angle = (byte & 0x03) * 90` degrees **counter-clockwise**.
    /// - angle = 0: 0° rotation -> EXIF 1 (Normal)
    /// - angle = 1: 90° CCW / 270° CW -> EXIF 8 (Rotate270)
    /// - angle = 2: 180° CCW / 180° CW -> EXIF 3 (Rotate180)
    /// - angle = 3: 270° CCW / 90° CW -> EXIF 6 (Rotate90 - standard iPhone vertical portrait)
    ///
    /// Per ISO/IEC 23008-12 Section 6.5.12 (imir):
    /// `axis = byte & 0x01` (0 = vertical flip, 1 = horizontal flip).
    pub fn container_orientation(&self) -> Option<u16> {
        if self.irot.is_none() && self.imir.is_none() {
            return None;
        }

        let angle = self.irot.unwrap_or(0) & 0x03;
        let mirror = self.imir;

        let orientation = match mirror {
            Some(1) => match angle {
                0 => 2, // Flip horizontal
                1 => 7, // 270° CW + flip horizontal (Transverse)
                2 => 4, // 180° + flip horizontal = Flip vertical
                3 => 5, // 90° CW + flip horizontal (Transpose)
                _ => 2,
            },
            Some(0) => match angle {
                0 => 4, // Flip vertical
                1 => 5, // 270° CW + flip vertical
                2 => 2, // 180° + flip vertical = Flip horizontal
                3 => 7, // 90° CW + flip vertical
                _ => 4,
            },
            _ => match angle {
                0 => 1, // Normal
                1 => 8, // 90° CCW = 270° CW
                2 => 3, // 180° CW
                3 => 6, // 270° CCW = 90° CW (iPhone vertical portrait)
                _ => 1,
            },
        };

        Some(orientation)
    }
}

pub fn is_isobmff_heif_or_avif(bytes: &[u8]) -> bool {
    if bytes.len() < 12 {
        return false;
    }
    if &bytes[4..8] != b"ftyp" {
        return false;
    }
    let major_brand = &bytes[8..12];
    matches!(
        major_brand,
        b"heic"
            | b"heix"
            | b"hevc"
            | b"hevx"
            | b"heim"
            | b"heis"
            | b"mif1"
            | b"msf1"
            | b"avif"
            | b"avis"
            | b"miaf"
    )
}

#[derive(Debug, Clone)]
enum IpcoProperty {
    Ispe { width: u32, height: u32 },
    Irot(u8),
    Imir(u8),
    Colr {
        cicp: Option<CicpInfo>,
        icc: Option<Vec<u8>>,
    },
    Pixi(u8),
    Other,
}

pub fn parse_heif_metadata(bytes: &[u8]) -> HeifMetadata {
    let mut meta = HeifMetadata::default();
    parse_isobmff_structure(bytes, &mut meta);

    // Fallbacks if not resolved via structured ISOBMFF parsing
    if meta.irot.is_none() {
        meta.irot = find_pattern_irot(bytes);
    }
    if meta.imir.is_none() {
        meta.imir = find_pattern_imir(bytes);
    }
    if meta.exif.is_none() {
        meta.exif = find_embedded_tiff_exif(bytes);
    }

    meta
}

fn read_box_header(bytes: &[u8], cursor: usize, end: usize) -> Option<([u8; 4], usize, usize)> {
    if cursor + 8 > end {
        return None;
    }
    let box_len_raw = u32::from_be_bytes(bytes[cursor..cursor + 4].try_into().ok()?) as usize;
    let box_type: [u8; 4] = bytes[cursor + 4..cursor + 8].try_into().ok()?;

    let (header_len, box_len) = if box_len_raw == 1 {
        if cursor + 16 > end {
            return None;
        }
        let len64 = u64::from_be_bytes(bytes[cursor + 8..cursor + 16].try_into().ok()?) as usize;
        (16, len64)
    } else if box_len_raw == 0 {
        (8, end - cursor)
    } else {
        (8, box_len_raw)
    };

    if box_len < header_len || cursor + box_len > end {
        return None;
    }

    Some((box_type, header_len, box_len))
}

fn parse_isobmff_structure(bytes: &[u8], meta: &mut HeifMetadata) {
    let mut cursor = 0;
    let end = bytes.len();

    // 1. Find the top-level 'meta' box
    let mut meta_payload: Option<&[u8]> = None;
    while cursor < end {
        let (box_type, header_len, box_len) = match read_box_header(bytes, cursor, end) {
            Some(h) => h,
            None => break,
        };

        if &box_type == b"meta" {
            // 'meta' is a FullBox: skip 4 bytes version & flags
            if box_len >= header_len + 4 {
                meta_payload = Some(&bytes[cursor + header_len + 4..cursor + box_len]);
            }
            break;
        }

        cursor += box_len;
    }

    let meta_bytes = match meta_payload {
        Some(m) => m,
        None => return,
    };

    let mut m_cursor = 0;
    let m_end = meta_bytes.len();
    let mut ipco_properties = Vec::new();
    let mut ipma_entries: Vec<&[u8]> = Vec::new();
    let mut exif_item_id: Option<u32> = None;
    let mut iloc_payload: Option<&[u8]> = None;
    let mut idat_payload: Option<&[u8]> = None;

    // Scan inside 'meta': pitm, iprp (ipco, ipma), iinf, iloc, idat
    while m_cursor < m_end {
        let (box_type, header_len, box_len) = match read_box_header(meta_bytes, m_cursor, m_end) {
            Some(h) => h,
            None => break,
        };

        let payload_start = m_cursor + header_len;
        let payload_end = m_cursor + box_len;
        let payload = &meta_bytes[payload_start..payload_end];

        match &box_type {
            b"pitm" => {
                // FullBox: 4 bytes version+flags, then item_id (2 bytes if ver=0, 4 bytes if ver>=1)
                if payload.len() >= 6 {
                    let ver = payload[0];
                    let item_id = if ver == 0 {
                        u16::from_be_bytes([payload[4], payload[5]]) as u32
                    } else if payload.len() >= 8 {
                        u32::from_be_bytes([payload[4], payload[5], payload[6], payload[7]])
                    } else {
                        0
                    };
                    meta.primary_item_id = Some(item_id);
                }
            }
            b"iprp" => {
                let mut p_cursor = 0;
                let p_end = payload.len();
                while p_cursor < p_end {
                    let (p_type, p_hdr_len, p_box_len) = match read_box_header(payload, p_cursor, p_end) {
                        Some(h) => h,
                        None => break,
                    };
                    let p_sub = &payload[p_cursor + p_hdr_len..p_cursor + p_box_len];
                    if &p_type == b"ipco" {
                        let mut c_cursor = 0;
                        let c_end = p_sub.len();
                        while c_cursor < c_end {
                            let (c_type, c_hdr_len, c_box_len) = match read_box_header(p_sub, c_cursor, c_end) {
                                Some(h) => h,
                                None => break,
                            };
                            let c_payload = &p_sub[c_cursor + c_hdr_len..c_cursor + c_box_len];
                            match &c_type {
                                b"ispe" => {
                                    // FullBox: 4 bytes version+flags, width: u32, height: u32
                                    if c_payload.len() >= 12 {
                                        let width = u32::from_be_bytes([c_payload[4], c_payload[5], c_payload[6], c_payload[7]]);
                                        let height = u32::from_be_bytes([c_payload[8], c_payload[9], c_payload[10], c_payload[11]]);
                                        ipco_properties.push(IpcoProperty::Ispe { width, height });
                                    } else {
                                        ipco_properties.push(IpcoProperty::Other);
                                    }
                                }
                                b"irot" => {
                                    if !c_payload.is_empty() {
                                        ipco_properties.push(IpcoProperty::Irot(c_payload[0] & 0x03));
                                    } else {
                                        ipco_properties.push(IpcoProperty::Other);
                                    }
                                }
                                b"imir" => {
                                    if !c_payload.is_empty() {
                                        ipco_properties.push(IpcoProperty::Imir(c_payload[0] & 0x01));
                                    } else {
                                        ipco_properties.push(IpcoProperty::Other);
                                    }
                                }
                                b"colr" => {
                                    if c_payload.len() >= 4 {
                                        let colr_type = &c_payload[..4];
                                        if colr_type == b"nclx" && c_payload.len() >= 11 {
                                            let primaries = u16::from_be_bytes([c_payload[4], c_payload[5]]);
                                            let transfer = u16::from_be_bytes([c_payload[6], c_payload[7]]);
                                            let matrix = u16::from_be_bytes([c_payload[8], c_payload[9]]);
                                            let full_range = (c_payload[10] & 0x80) != 0;
                                            ipco_properties.push(IpcoProperty::Colr {
                                                cicp: Some(CicpInfo {
                                                    color_primaries: primaries,
                                                    transfer_characteristics: transfer,
                                                    matrix_coefficients: matrix,
                                                    full_range,
                                                }),
                                                icc: None,
                                            });
                                        } else if (colr_type == b"prof" || colr_type == b"rICC") && c_payload.len() > 4 {
                                            ipco_properties.push(IpcoProperty::Colr {
                                                cicp: None,
                                                icc: Some(c_payload[4..].to_vec()),
                                            });
                                        } else {
                                            ipco_properties.push(IpcoProperty::Other);
                                        }
                                    } else {
                                        ipco_properties.push(IpcoProperty::Other);
                                    }
                                }
                                b"pixi" => {
                                    if c_payload.len() >= 6 {
                                        let num_channels = c_payload[4] as usize;
                                        if c_payload.len() >= 5 + num_channels && num_channels > 0 {
                                            ipco_properties.push(IpcoProperty::Pixi(c_payload[5]));
                                        } else {
                                            ipco_properties.push(IpcoProperty::Other);
                                        }
                                    } else {
                                        ipco_properties.push(IpcoProperty::Other);
                                    }
                                }
                                _ => ipco_properties.push(IpcoProperty::Other),
                            }
                            c_cursor += c_box_len;
                        }
                    } else if &p_type == b"ipma" {
                        ipma_entries.push(p_sub);
                    }
                    p_cursor += p_box_len;
                }
            }
            b"iinf" => {
                if payload.len() >= 6 {
                    let ver = payload[0];
                    let mut i_cursor = if ver == 0 { 6 } else { 8 };
                    let i_end = payload.len();
                    while i_cursor < i_end {
                        let (i_type, i_hdr_len, i_box_len) = match read_box_header(payload, i_cursor, i_end) {
                            Some(h) => h,
                            None => break,
                        };
                        let i_sub = &payload[i_cursor + i_hdr_len..i_cursor + i_box_len];
                        if &i_type == b"infe" && i_sub.len() >= 12 {
                            let infe_ver = i_sub[0];
                            if infe_ver == 2 {
                                let item_id = u16::from_be_bytes([i_sub[4], i_sub[5]]) as u32;
                                if &i_sub[8..12] == b"Exif" {
                                    exif_item_id = Some(item_id);
                                }
                            } else if infe_ver == 3 && i_sub.len() >= 14 {
                                let item_id = u32::from_be_bytes([i_sub[4], i_sub[5], i_sub[6], i_sub[7]]);
                                if &i_sub[10..14] == b"Exif" {
                                    exif_item_id = Some(item_id);
                                }
                            }
                        }
                        i_cursor += i_box_len;
                    }
                }
            }
            b"iloc" => {
                iloc_payload = Some(payload);
            }
            b"idat" => {
                idat_payload = Some(payload);
            }
            _ => {}
        }

        m_cursor += box_len;
    }

    // 2. Associate properties specifically with the Primary Item ID via ipma
    if let Some(pri_id) = meta.primary_item_id {
        for ipma in &ipma_entries {
            if ipma.len() < 8 {
                continue;
            }
            let ver = ipma[0];
            let flags = u32::from_be_bytes([0, ipma[1], ipma[2], ipma[3]]);
            let entry_count = u32::from_be_bytes([ipma[4], ipma[5], ipma[6], ipma[7]]) as usize;
            let mut cur = 8;
            for _ in 0..entry_count {
                if cur >= ipma.len() {
                    break;
                }
                let item_id = if ver < 1 {
                    if cur + 2 > ipma.len() { break; }
                    let id = u16::from_be_bytes([ipma[cur], ipma[cur + 1]]) as u32;
                    cur += 2;
                    id
                } else {
                    if cur + 4 > ipma.len() { break; }
                    let id = u32::from_be_bytes([ipma[cur], ipma[cur + 1], ipma[cur + 2], ipma[cur + 3]]);
                    cur += 4;
                    id
                };
                if cur >= ipma.len() { break; }
                let assoc_count = ipma[cur] as usize;
                cur += 1;
                for _ in 0..assoc_count {
                    let prop_idx = if (flags & 1) != 0 {
                        if cur + 2 > ipma.len() { break; }
                        let v = u16::from_be_bytes([ipma[cur], ipma[cur + 1]]);
                        cur += 2;
                        (v & 0x7FFF) as usize
                    } else {
                        if cur >= ipma.len() { break; }
                        let v = ipma[cur];
                        cur += 1;
                        (v & 0x7F) as usize
                    };

                    if item_id == pri_id && prop_idx >= 1 && prop_idx <= ipco_properties.len() {
                        match &ipco_properties[prop_idx - 1] {
                            IpcoProperty::Ispe { width, height } => {
                                if meta.ispe_width.is_none() {
                                    meta.ispe_width = Some(*width);
                                    meta.ispe_height = Some(*height);
                                }
                            }
                            IpcoProperty::Irot(angle) => {
                                if meta.irot.is_none() {
                                    meta.irot = Some(*angle);
                                }
                            }
                            IpcoProperty::Imir(axis) => {
                                if meta.imir.is_none() {
                                    meta.imir = Some(*axis);
                                }
                            }
                            IpcoProperty::Colr { cicp, icc } => {
                                if meta.cicp.is_none() && meta.icc_profile.is_none() {
                                    meta.cicp = *cicp;
                                    meta.icc_profile = icc.clone();
                                }
                            }
                            IpcoProperty::Pixi(depth) => {
                                if meta.bit_depth.is_none() {
                                    meta.bit_depth = Some(*depth);
                                }
                            }
                            IpcoProperty::Other => {}
                        }
                    }
                }
            }
        }
    }

    // Fallback: If no primary item association was found, scan ipco properties directly
    if meta.ispe_width.is_none() {
        let mut max_area = 0u64;
        for p in &ipco_properties {
            if let IpcoProperty::Ispe { width, height } = p {
                let area = (*width as u64) * (*height as u64);
                if area > max_area {
                    max_area = area;
                    meta.ispe_width = Some(*width);
                    meta.ispe_height = Some(*height);
                }
            }
        }
    }
    if meta.irot.is_none() {
        for p in &ipco_properties {
            if let IpcoProperty::Irot(angle) = p {
                meta.irot = Some(*angle);
                break;
            }
        }
    }
    if meta.imir.is_none() {
        for p in &ipco_properties {
            if let IpcoProperty::Imir(axis) = p {
                meta.imir = Some(*axis);
                break;
            }
        }
    }
    if meta.cicp.is_none() && meta.icc_profile.is_none() {
        for p in &ipco_properties {
            if let IpcoProperty::Colr { cicp, icc } = p {
                meta.cicp = *cicp;
                meta.icc_profile = icc.clone();
                break;
            }
        }
    }
    if meta.bit_depth.is_none() {
        for p in &ipco_properties {
            if let IpcoProperty::Pixi(depth) = p {
                meta.bit_depth = Some(*depth);
                break;
            }
        }
    }

    // 3. Extract Exif payload via iloc
    if let (Some(exif_id), Some(iloc)) = (exif_item_id, iloc_payload) {
        if iloc.len() >= 6 {
            let ver = iloc[0];
            let off_sz = ((iloc[4] >> 4) & 0x0F) as usize;
            let len_sz = (iloc[4] & 0x0F) as usize;
            let base_sz = ((iloc[5] >> 4) & 0x0F) as usize;
            let idx_sz = if matches!(ver, 1 | 2) { (iloc[5] & 0x0F) as usize } else { 0 };
            let mut cur = 6;
            let item_count = if ver < 2 {
                if cur + 2 > iloc.len() { 0 } else {
                    let c = u16::from_be_bytes([iloc[cur], iloc[cur + 1]]) as usize;
                    cur += 2;
                    c
                }
            } else {
                if cur + 4 > iloc.len() { 0 } else {
                    let c = u32::from_be_bytes([iloc[cur], iloc[cur + 1], iloc[cur + 2], iloc[cur + 3]]) as usize;
                    cur += 4;
                    c
                }
            };

            let read_u = |buf: &[u8], pos: usize, sz: usize| -> Option<u64> {
                if sz == 0 { return Some(0); }
                if pos + sz > buf.len() { return None; }
                match sz {
                    1 => Some(buf[pos] as u64),
                    2 => Some(u16::from_be_bytes([buf[pos], buf[pos + 1]]) as u64),
                    4 => Some(u32::from_be_bytes([buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]]) as u64),
                    8 => Some(u64::from_be_bytes([
                        buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3],
                        buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7],
                    ])),
                    _ => None,
                }
            };

            for _ in 0..item_count {
                if cur >= iloc.len() { break; }
                let item_id = if ver < 2 {
                    if cur + 2 > iloc.len() { break; }
                    let id = u16::from_be_bytes([iloc[cur], iloc[cur + 1]]) as u32;
                    cur += 2;
                    id
                } else {
                    if cur + 4 > iloc.len() { break; }
                    let id = u32::from_be_bytes([iloc[cur], iloc[cur + 1], iloc[cur + 2], iloc[cur + 3]]);
                    cur += 4;
                    id
                };
                let construction_method = if matches!(ver, 1 | 2) {
                    if cur + 2 > iloc.len() { break; }
                    let cm = iloc[cur + 1] & 0x0F;
                    cur += 2;
                    cm
                } else {
                    0
                };
                if cur + 2 > iloc.len() { break; }
                let _dref = u16::from_be_bytes([iloc[cur], iloc[cur + 1]]);
                cur += 2;

                let base_off = match read_u(iloc, cur, base_sz) {
                    Some(v) => { cur += base_sz; v },
                    None => break,
                };

                if cur + 2 > iloc.len() { break; }
                let ext_count = u16::from_be_bytes([iloc[cur], iloc[cur + 1]]) as usize;
                cur += 2;

                for _ in 0..ext_count {
                    if matches!(ver, 1 | 2) && idx_sz > 0 { cur += idx_sz; }
                    let ext_off = match read_u(iloc, cur, off_sz) {
                        Some(v) => { cur += off_sz; v },
                        None => break,
                    };
                    let ext_len = match read_u(iloc, cur, len_sz) {
                        Some(v) => { cur += len_sz; v },
                        None => break,
                    };

                    if item_id == exif_id {
                        let abs_off = (base_off + ext_off) as usize;
                        let length = ext_len as usize;

                        let exif_bytes = if construction_method == 0 {
                            if abs_off + length <= bytes.len() {
                                Some(&bytes[abs_off..abs_off + length])
                            } else {
                                None
                            }
                        } else if construction_method == 1 {
                            if let Some(idat) = idat_payload {
                                if abs_off + length <= idat.len() {
                                    Some(&idat[abs_off..abs_off + length])
                                } else {
                                    None
                                }
                            } else {
                                None
                            }
                        } else {
                            None
                        };

                        if let Some(raw_exif) = exif_bytes {
                            meta.exif = extract_exif_payload(raw_exif);
                        }
                    }
                }
            }
        }
    }
}

pub fn extract_exif_payload(payload: &[u8]) -> Option<Vec<u8>> {
    if payload.len() < 8 {
        return None;
    }
    // In HEIF/ISOBMFF, the Exif item payload starts with a 4-byte offset field
    // indicating the byte offset from the end of this 4-byte field to the TIFF header.
    let offset_prefix = u32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]) as usize;
    if 4 + offset_prefix + 4 <= payload.len() {
        let candidate = &payload[4 + offset_prefix..];
        if candidate.starts_with(b"II*\0") || candidate.starts_with(b"MM\0*") {
            return Some(candidate.to_vec());
        }
    }
    if payload.starts_with(b"II*\0") || payload.starts_with(b"MM\0*") {
        return Some(payload.to_vec());
    }
    if payload.starts_with(b"Exif\0\0") && payload.len() > 6 {
        let sub = &payload[6..];
        if sub.starts_with(b"II*\0") || sub.starts_with(b"MM\0*") {
            return Some(sub.to_vec());
        }
    }
    None
}

fn find_pattern_irot(bytes: &[u8]) -> Option<u8> {
    let limit = bytes.len().min(4 * 1024 * 1024);
    let slice = &bytes[..limit];
    for i in 0..slice.len().saturating_sub(9) {
        if &slice[i..i + 8] == b"\x00\x00\x00\x09irot"
            || (&slice[i + 4..i + 8] == b"irot" && slice[i..i + 4] == [0, 0, 0, 9])
        {
            let angle = slice[i + 8] & 0x03;
            return Some(angle);
        }
    }
    None
}

fn find_pattern_imir(bytes: &[u8]) -> Option<u8> {
    let limit = bytes.len().min(4 * 1024 * 1024);
    let slice = &bytes[..limit];
    for i in 0..slice.len().saturating_sub(9) {
        if &slice[i..i + 8] == b"\x00\x00\x00\x09imir"
            || (&slice[i + 4..i + 8] == b"imir" && slice[i..i + 4] == [0, 0, 0, 9])
        {
            let axis = slice[i + 8] & 0x01;
            return Some(axis);
        }
    }
    None
}

fn find_embedded_tiff_exif(bytes: &[u8]) -> Option<Vec<u8>> {
    let search_limit = bytes.len().min(8 * 1024 * 1024);
    let slice = &bytes[..search_limit];

    // 1. Search for Exif\0\0 header
    for i in 0..slice.len().saturating_sub(12) {
        if &slice[i..i + 4] == b"Exif" && &slice[i + 4..i + 6] == b"\0\0" {
            let candidate = &slice[i + 6..];
            if candidate.starts_with(b"II*\0") || candidate.starts_with(b"MM\0*") {
                return Some(candidate.to_vec());
            }
        }
    }

    // 2. Search for raw TIFF header: little-endian (II*\0) or big-endian (MM\0*) with standard IFD0 offset
    for i in 0..slice.len().saturating_sub(8) {
        if &slice[i..i + 4] == b"II*\0" || &slice[i..i + 4] == b"MM\0*" {
            let candidate = &slice[i..];
            if exif::Reader::new()
                .read_raw(candidate[..candidate.len().min(65536)].to_vec())
                .is_ok()
            {
                return Some(candidate.to_vec());
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_isobmff_detection() {
        let mut heic_header = vec![0x00, 0x00, 0x00, 0x18, b'f', b't', b'y', b'p', b'h', b'e', b'i', b'c'];
        heic_header.extend_from_slice(&[0; 12]);
        assert!(is_isobmff_heif_or_avif(&heic_header));

        let mut avif_header = vec![0x00, 0x00, 0x00, 0x18, b'f', b't', b'y', b'p', b'a', b'v', b'i', b'f'];
        avif_header.extend_from_slice(&[0; 12]);
        assert!(is_isobmff_heif_or_avif(&avif_header));

        let png_header = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        assert!(!is_isobmff_heif_or_avif(&png_header));
    }

    #[test]
    fn test_parse_meta_fullbox_and_nested_ipco_irot() {
        // Construct realistic iPhone ISOBMFF hierarchy:
        // root -> ftyp -> meta (FullBox) -> [pitm, iprp -> [ipco, ipma]]
        let mut data = Vec::new();

        // 1. ftyp box (20 bytes)
        data.extend_from_slice(&[0x00, 0x00, 0x00, 0x14, b'f', b't', b'y', b'p', b'h', b'e', b'i', b'c', 0, 0, 0, 0, b'm', b'i', b'f', b'1']);

        // Build ipco payload
        let mut ipco_payload = Vec::new();

        // [prop 1] colr nclx box (primaries=12 Display P3, transfer=13, matrix=6, full=1)
        let colr_payload = [
            b'n', b'c', b'l', b'x',
            0x00, 12, // primaries = 12 (Display P3)
            0x00, 13, // transfer = 13 (IEC 61966-2-1 / sRGB)
            0x00, 6,  // matrix = 6
            0x80,     // full range
        ];
        let colr_len = (8 + colr_payload.len()) as u32;
        ipco_payload.extend_from_slice(&colr_len.to_be_bytes());
        ipco_payload.extend_from_slice(b"colr");
        ipco_payload.extend_from_slice(&colr_payload);

        // [prop 2] ispe box (width=4032, height=3024)
        let mut ispe_payload = vec![0x00, 0x00, 0x00, 0x00]; // version/flags
        ispe_payload.extend_from_slice(&4032u32.to_be_bytes());
        ispe_payload.extend_from_slice(&3024u32.to_be_bytes());
        let ispe_len = (8 + ispe_payload.len()) as u32;
        ipco_payload.extend_from_slice(&ispe_len.to_be_bytes());
        ipco_payload.extend_from_slice(b"ispe");
        ipco_payload.extend_from_slice(&ispe_payload);

        // [prop 3] pixi box (10-bit, 3 channels)
        let pixi_payload = [
            0x00, 0x00, 0x00, 0x00, // version/flags
            3,                      // 3 channels
            10, 10, 10,             // 10-bit each
        ];
        let pixi_len = (8 + pixi_payload.len()) as u32;
        ipco_payload.extend_from_slice(&pixi_len.to_be_bytes());
        ipco_payload.extend_from_slice(b"pixi");
        ipco_payload.extend_from_slice(&pixi_payload);

        // [prop 4] irot box (angle = 3 -> 270° CCW = 90° CW vertical portrait)
        ipco_payload.extend_from_slice(&[0x00, 0x00, 0x00, 0x09, b'i', b'r', b'o', b't', 3]);

        // Wrap into ipco box
        let mut iprp_payload = Vec::new();
        let ipco_len = (8 + ipco_payload.len()) as u32;
        iprp_payload.extend_from_slice(&ipco_len.to_be_bytes());
        iprp_payload.extend_from_slice(b"ipco");
        iprp_payload.extend_from_slice(&ipco_payload);

        // Build ipma box: Item 1 is associated with props 1, 2, 3, 4
        let ipma_payload = vec![
            0x00, 0x00, 0x00, 0x00, // version 0, flags 0
            0x00, 0x00, 0x00, 0x01, // 1 entry
            0x00, 0x01,             // item_id = 1
            0x04,                   // 4 associations
            0x01, 0x02, 0x03, 0x04, // prop indices 1, 2, 3, 4
        ];
        let ipma_len = (8 + ipma_payload.len()) as u32;
        iprp_payload.extend_from_slice(&ipma_len.to_be_bytes());
        iprp_payload.extend_from_slice(b"ipma");
        iprp_payload.extend_from_slice(&ipma_payload);

        // Wrap into iprp box
        let mut meta_children = Vec::new();

        // pitm box (Primary Item ID = 1)
        let pitm_payload = [
            0x00, 0x00, 0x00, 0x00, // version 0, flags 0
            0x00, 0x01,             // item_id = 1
        ];
        let pitm_len = (8 + pitm_payload.len()) as u32;
        meta_children.extend_from_slice(&pitm_len.to_be_bytes());
        meta_children.extend_from_slice(b"pitm");
        meta_children.extend_from_slice(&pitm_payload);

        let iprp_len = (8 + iprp_payload.len()) as u32;
        meta_children.extend_from_slice(&iprp_len.to_be_bytes());
        meta_children.extend_from_slice(b"iprp");
        meta_children.extend_from_slice(&iprp_payload);

        // Wrap into meta FullBox (4 bytes version & flags: 0x00, 0x00, 0x00, 0x00)
        let meta_payload_len = 4 + meta_children.len();
        let meta_len = (8 + meta_payload_len) as u32;
        data.extend_from_slice(&meta_len.to_be_bytes());
        data.extend_from_slice(b"meta");
        data.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]); // FullBox version+flags
        data.extend_from_slice(&meta_children);

        let meta = parse_heif_metadata(&data);
        assert_eq!(meta.primary_item_id, Some(1));
        assert_eq!(meta.ispe_width, Some(4032));
        assert_eq!(meta.ispe_height, Some(3024));
        assert!(meta.cicp.is_some());
        let cicp = meta.cicp.unwrap();
        assert_eq!(cicp.color_primaries, 12);
        assert_eq!(meta.bit_depth, Some(10));
        assert_eq!(meta.irot, Some(3));
        // Angle 3 (270° CCW = 90° CW) maps to EXIF Orientation 6 (Rotate90)
        assert_eq!(meta.container_orientation(), Some(6));
    }

    #[test]
    fn test_irot_rotation_semantics() {
        // Angle 0: 0° -> Orientation 1 (Normal)
        let mut m = HeifMetadata::default();
        m.irot = Some(0);
        assert_eq!(m.container_orientation(), Some(1));

        // Angle 1: 90° CCW / 270° CW -> Orientation 8 (Rotate270)
        m.irot = Some(1);
        assert_eq!(m.container_orientation(), Some(8));

        // Angle 2: 180° -> Orientation 3 (Rotate180)
        m.irot = Some(2);
        assert_eq!(m.container_orientation(), Some(3));

        // Angle 3: 270° CCW / 90° CW -> Orientation 6 (Rotate90)
        m.irot = Some(3);
        assert_eq!(m.container_orientation(), Some(6));

        // With Horizontal Mirror (imir = 1)
        m.imir = Some(1);
        m.irot = Some(0);
        assert_eq!(m.container_orientation(), Some(2)); // Horizontal flip
        m.irot = Some(3);
        assert_eq!(m.container_orientation(), Some(5)); // 90° CW + horizontal flip
    }

    #[test]
    fn test_heif_exif_header_offset() {
        let mut payload = vec![0x00, 0x00, 0x00, 0x00]; // 4-byte offset = 0
        payload.extend_from_slice(b"II*\0\x08\x00\x00\x00"); // TIFF header + IFD0 offset
        payload.extend_from_slice(&[0; 16]); // IFD payload

        let extracted = extract_exif_payload(&payload);
        assert!(extracted.is_some());
        let tiff_bytes = extracted.unwrap();
        assert!(tiff_bytes.starts_with(b"II*\0"));
    }

    #[test]
    fn test_real_heic_box_structure_parsing() {
        // Construct synthetic ISOBMFF hierarchy matching real iPhone HEIC structure:
        // ftyp + meta [ pitm (ID 49), iprp [ ipco (colr, ispe, pixi, irot), ipma ], iinf [ infe (Exif ID 65) ], iloc ] + synthetic exif_payload
        let mut ftyp = Vec::new();
        ftyp.extend_from_slice(&[0x00, 0x00, 0x00, 0x14, b'f', b't', b'y', b'p', b'h', b'e', b'i', b'c', 0, 0, 0, 0, b'm', b'i', b'f', b'1']);

        // Build ipco
        let mut ipco_payload = Vec::new();
        // prop 1: colr (Display P3)
        let colr_payload = [b'n', b'c', b'l', b'x', 0x00, 12, 0x00, 13, 0x00, 6, 0x80];
        let colr_len = (8 + colr_payload.len()) as u32;
        ipco_payload.extend_from_slice(&colr_len.to_be_bytes());
        ipco_payload.extend_from_slice(b"colr");
        ipco_payload.extend_from_slice(&colr_payload);

        // prop 2: ispe (4032 x 3024)
        let mut ispe_payload = vec![0x00, 0x00, 0x00, 0x00];
        ispe_payload.extend_from_slice(&4032u32.to_be_bytes());
        ispe_payload.extend_from_slice(&3024u32.to_be_bytes());
        let ispe_len = (8 + ispe_payload.len()) as u32;
        ipco_payload.extend_from_slice(&ispe_len.to_be_bytes());
        ipco_payload.extend_from_slice(b"ispe");
        ipco_payload.extend_from_slice(&ispe_payload);

        // prop 3: pixi (8-bit)
        let pixi_payload = [0x00, 0x00, 0x00, 0x00, 3, 8, 8, 8];
        let pixi_len = (8 + pixi_payload.len()) as u32;
        ipco_payload.extend_from_slice(&pixi_len.to_be_bytes());
        ipco_payload.extend_from_slice(b"pixi");
        ipco_payload.extend_from_slice(&pixi_payload);

        // prop 4: irot (angle 3 -> 270° CCW / 90° CW)
        let irot_len = 9u32;
        ipco_payload.extend_from_slice(&irot_len.to_be_bytes());
        ipco_payload.extend_from_slice(b"irot");
        ipco_payload.push(3);

        let mut iprp_payload = Vec::new();
        let ipco_len = (8 + ipco_payload.len()) as u32;
        iprp_payload.extend_from_slice(&ipco_len.to_be_bytes());
        iprp_payload.extend_from_slice(b"ipco");
        iprp_payload.extend_from_slice(&ipco_payload);

        // ipma: Associate Item 49 with props 1, 2, 3, 4
        let ipma_payload = vec![
            0x00, 0x00, 0x00, 0x00, // version 0, flags 0
            0x00, 0x00, 0x00, 0x01, // 1 entry
            0x00, 0x31,             // item_id = 49 (0x0031)
            0x04,                   // 4 associations
            0x01, 0x02, 0x03, 0x04,
        ];
        let ipma_len = (8 + ipma_payload.len()) as u32;
        iprp_payload.extend_from_slice(&ipma_len.to_be_bytes());
        iprp_payload.extend_from_slice(b"ipma");
        iprp_payload.extend_from_slice(&ipma_payload);

        // iinf: infe item 65 is Exif
        let infe_payload = [
            0x02, 0x00, 0x00, 0x00, // version 2, flags 0
            0x00, 0x41,             // item_id = 65 (0x0041)
            0x00, 0x00,             // protection
            b'E', b'x', b'i', b'f', // item_type
        ];
        let infe_len = (8 + infe_payload.len()) as u32;
        let mut iinf_payload = vec![
            0x00, 0x00, 0x00, 0x00, // version 0, flags 0
            0x00, 0x01,             // entry_count = 1
        ];
        iinf_payload.extend_from_slice(&infe_len.to_be_bytes());
        iinf_payload.extend_from_slice(b"infe");
        iinf_payload.extend_from_slice(&infe_payload);
        let iinf_len = (8 + iinf_payload.len()) as u32;

        // Synthetic Exif payload (pure synthetic TIFF, zero PII)
        let mut synthetic_exif = vec![0x00, 0x00, 0x00, 0x00]; // 4-byte offset = 0
        synthetic_exif.extend_from_slice(b"MM\0*\0\0\0\x08"); // TIFF header (big-endian)
        synthetic_exif.extend_from_slice(&[
            0x00, 0x01, // 1 entry
            0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00, // Tag 0x0112 = 6
            0x00, 0x00, 0x00, 0x00, // Next IFD offset = 0
        ]);

        let pitm_len = 8 + 6u32;
        let iprp_box_len = 8 + iprp_payload.len() as u32;
        let iloc_payload_len = 4 + 2 + 2 + 2 + 2 + 2 + 4 + 4; // 22 bytes
        let iloc_box_len = 8 + iloc_payload_len as u32;
        let meta_children_len = pitm_len + iprp_box_len + iinf_len + iloc_box_len;
        let meta_box_len = 8 + 4 + meta_children_len;
        let exif_offset = (ftyp.len() as u32) + meta_box_len;

        // iloc box
        let mut iloc_payload = vec![
            0x00, 0x00, 0x00, 0x00, // version 0, flags 0
            0x44,                   // offset_size=4, length_size=4
            0x00,                   // base_offset_size=0, index_size=0
            0x00, 0x01,             // item_count = 1
            0x00, 0x41,             // item_id = 65
            0x00, 0x00,             // dref_index = 0
            0x00, 0x01,             // extent_count = 1
        ];
        iloc_payload.extend_from_slice(&exif_offset.to_be_bytes());
        iloc_payload.extend_from_slice(&(synthetic_exif.len() as u32).to_be_bytes());

        let mut meta_children = Vec::new();
        // pitm
        meta_children.extend_from_slice(&pitm_len.to_be_bytes());
        meta_children.extend_from_slice(b"pitm");
        meta_children.extend_from_slice(&[0x00, 0x00, 0x00, 0x00, 0x00, 0x31]); // ID 49

        // iprp
        meta_children.extend_from_slice(&iprp_box_len.to_be_bytes());
        meta_children.extend_from_slice(b"iprp");
        meta_children.extend_from_slice(&iprp_payload);

        // iinf
        meta_children.extend_from_slice(&iinf_len.to_be_bytes());
        meta_children.extend_from_slice(b"iinf");
        meta_children.extend_from_slice(&iinf_payload);

        // iloc
        meta_children.extend_from_slice(&iloc_box_len.to_be_bytes());
        meta_children.extend_from_slice(b"iloc");
        meta_children.extend_from_slice(&iloc_payload);

        // Assemble full file: ftyp + meta + synthetic_exif
        let mut file_bytes = ftyp;
        file_bytes.extend_from_slice(&meta_box_len.to_be_bytes());
        file_bytes.extend_from_slice(b"meta");
        file_bytes.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]); // FullBox version+flags
        file_bytes.extend_from_slice(&meta_children);
        assert_eq!(file_bytes.len(), exif_offset as usize);
        file_bytes.extend_from_slice(&synthetic_exif);

        // Parse and verify
        let meta = parse_heif_metadata(&file_bytes);
        assert_eq!(meta.primary_item_id, Some(49));
        assert_eq!(meta.ispe_width, Some(4032));
        assert_eq!(meta.ispe_height, Some(3024));
        assert_eq!(meta.irot, Some(3));
        assert_eq!(meta.container_orientation(), Some(6));
        assert!(meta.exif.is_some());
        let exif = meta.exif.unwrap();
        assert!(exif.starts_with(b"MM\0*"));
    }
}
