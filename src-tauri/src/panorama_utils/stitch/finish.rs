pub fn coverage_crop(label: &[u16], w: usize, h: usize) -> Option<[f64; 4]> {
    if w == 0 || h == 0 {
        return None;
    }
    let (x, y, cw, ch) = largest_covered(label, w, h)?;
    Some([
        x as f64 / w as f64,
        y as f64 / h as f64,
        cw as f64 / w as f64,
        ch as f64 / h as f64,
    ])
}

fn largest_covered(label: &[u16], w: usize, h: usize) -> Option<(usize, usize, usize, usize)> {
    let mut heights = vec![0usize; w];
    let mut stack = Vec::with_capacity(w + 1);
    let mut best_area = 0usize;
    let mut best = (0usize, 0usize, 0usize, 0usize);
    for y in 0..h {
        let row = &label[y * w..y * w + w];
        for x in 0..w {
            heights[x] = if row[x] != u16::MAX {
                heights[x] + 1
            } else {
                0
            };
        }
        stack.clear();
        for i in 0..=w {
            let cur = if i < w { heights[i] } else { 0 };
            while let Some(&top) = stack.last() {
                if heights[top] <= cur {
                    break;
                }
                stack.pop();
                let hgt = heights[top];
                let left = stack.last().copied().map_or(0, |s| s + 1);
                let width = i - left;
                let area = hgt * width;
                if area > best_area {
                    best_area = area;
                    best = (left, y + 1 - hgt, width, hgt);
                }
            }
            stack.push(i);
        }
    }
    (best_area > 0).then_some(best)
}
