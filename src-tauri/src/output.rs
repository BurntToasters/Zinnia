//! Byte-bounded, UTF-8-safe output buffering helpers.

pub const MAX_OUTPUT_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_LOG_ENTRY_BYTES: usize = 16 * 1024;

pub fn truncate_for_bytes(input: &str, max_bytes: usize) -> String {
    if input.len() <= max_bytes {
        return input.to_string();
    }

    let mut boundary = max_bytes;
    while boundary > 0 && !input.is_char_boundary(boundary) {
        boundary -= 1;
    }

    let omitted = input.len().saturating_sub(boundary);
    format!("{} [truncated {} bytes]", &input[..boundary], omitted)
}

pub fn append_limited_output(target: &mut String, chunk: &str, max_bytes: usize, truncated: &mut bool) {
    if *truncated {
        return;
    }

    if target.len() >= max_bytes {
        *truncated = true;
        return;
    }

    let remaining = max_bytes - target.len();
    if chunk.len() <= remaining {
        target.push_str(chunk);
        return;
    }

    let mut boundary = remaining;
    while boundary > 0 && !chunk.is_char_boundary(boundary) {
        boundary -= 1;
    }

    if boundary > 0 {
        target.push_str(&chunk[..boundary]);
    }
    *truncated = true;
}

pub fn sanitize_output(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control() || matches!(*c, '\n' | '\t'))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_for_bytes_caps_large_entries() {
        let long = "x".repeat(MAX_LOG_ENTRY_BYTES + 100);
        let truncated = truncate_for_bytes(&long, MAX_LOG_ENTRY_BYTES);
        assert!(truncated.len() <= MAX_LOG_ENTRY_BYTES + 64);
        assert!(truncated.contains("[truncated"));
    }

    #[test]
    fn append_limited_output_marks_truncation_when_over_limit() {
        let mut out = String::new();
        let mut truncated = false;

        append_limited_output(&mut out, "abcdef", 4, &mut truncated);
        assert_eq!(out, "abcd");
        assert!(truncated);
    }

    #[test]
    fn append_limited_output_preserves_utf8_boundaries() {
        let mut out = String::new();
        let mut truncated = false;
        let chunk = "ééé";

        append_limited_output(&mut out, chunk, 5, &mut truncated);
        assert_eq!(out, "éé");
        assert!(truncated);
        assert!(std::str::from_utf8(out.as_bytes()).is_ok());
    }
}
