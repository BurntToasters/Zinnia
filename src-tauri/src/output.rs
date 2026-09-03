//! Byte-bounded, UTF-8-safe output buffering helpers.

pub const MAX_OUTPUT_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_LOG_ENTRY_BYTES: usize = 16 * 1024;

#[derive(Default)]
pub struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut decoded = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(valid) => {
                    decoded.push_str(valid);
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    if valid_up_to > 0 {
                        if let Ok(valid) = std::str::from_utf8(&self.pending[..valid_up_to]) {
                            decoded.push_str(valid);
                        }
                        self.pending.drain(..valid_up_to);
                    }
                    let Some(error_len) = error.error_len() else {
                        break;
                    };
                    decoded.push('\u{fffd}');
                    self.pending.drain(..error_len);
                }
            }
        }
        decoded
    }

    pub fn finish(&mut self) -> String {
        let decoded = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        decoded
    }
}

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

pub fn append_limited_output(
    target: &mut String,
    chunk: &str,
    max_bytes: usize,
    truncated: &mut bool,
) {
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
    // Keep `\r`: 7-Zip `-bsp1` rewrites progress on the same line with CR.
    // Stripping it merges updates and breaks raw `7z-progress` listeners.
    let cleaned: String = s
        .chars()
        .filter(|c| !c.is_control() || matches!(*c, '\n' | '\t' | '\r'))
        .collect();
    redact_sensitive_text(&cleaned)
}

/// Redact 7-Zip `-p` passwords and common secret key=value forms from log/output text.
pub fn redact_sensitive_text(input: &str) -> String {
    let with_args = redact_password_args(input);
    redact_key_value_secrets(&with_args)
}

fn is_password_token(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    // Fail closed like utils.ts: 7-Zip passwords attach directly to `-p` and
    // may contain spaces, so the rest of the line cannot be shown safely.
    lower.starts_with("-p") && lower != "-p***"
}

fn redact_password_args(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for line in input.split_inclusive('\n') {
        let body = line.strip_suffix('\n').unwrap_or(line);
        let mut offset = 0usize;
        let mut cut = None;
        for token in body.split_whitespace() {
            let start = offset + body[offset..].find(token).unwrap_or(0);
            offset = start + token.len();
            if is_password_token(token) {
                cut = Some(start);
                break;
            }
        }
        match cut {
            Some(start) => {
                out.push_str(&body[..start]);
                out.push_str("-p***");
                if line.len() > body.len() {
                    out.push('\n');
                }
            }
            None => out.push_str(line),
        }
    }
    out
}

fn redact_key_value_secrets(input: &str) -> String {
    let keys = [
        "password",
        "passphrase",
        "token",
        "private_key",
        "private-key",
    ];
    let lower = input.to_ascii_lowercase();
    let mut redacted = String::with_capacity(input.len());
    let mut i = 0usize;
    while i < input.len() {
        let slice = &lower[i..];
        let matched = keys.iter().find(|key| slice.starts_with(*key)).copied();
        if let Some(key) = matched {
            let boundary_ok = i == 0
                || input[..i]
                    .chars()
                    .next_back()
                    .is_some_and(|c| !c.is_ascii_alphanumeric() && c != '_');
            let after_key = i + key.len();
            let sep = input[after_key..].chars().next();
            if boundary_ok && matches!(sep, Some('=') | Some(':')) {
                redacted.push_str(&input[i..after_key]);
                let sep_ch = sep.unwrap();
                redacted.push(sep_ch);
                i = after_key + sep_ch.len_utf8();
                while i < input.len() && !input[i..].chars().next().unwrap().is_whitespace() {
                    i += input[i..].chars().next().unwrap().len_utf8();
                }
                redacted.push_str("***");
                continue;
            }
        }
        let ch = input[i..].chars().next().unwrap();
        redacted.push(ch);
        i += ch.len_utf8();
    }
    redacted
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

    #[test]
    fn stream_decoder_preserves_multibyte_characters_split_across_chunks() {
        let mut decoder = Utf8StreamDecoder::default();
        let bytes = "café".as_bytes();
        assert_eq!(decoder.push(&bytes[..4]), "caf");
        assert_eq!(decoder.push(&bytes[4..]), "é");
        assert_eq!(decoder.finish(), "");
    }

    #[test]
    fn sanitize_output_preserves_carriage_return_progress() {
        assert_eq!(
            sanitize_output(" 10% a.txt\r 80% + b.txt"),
            " 10% a.txt\r 80% + b.txt"
        );
    }

    #[test]
    fn redact_sensitive_text_masks_password_args() {
        // Mirrors utils.ts ARG_PASSWORD_PATTERN: everything after an attached
        // -p on the line is redacted, because a password could contain spaces.
        assert_eq!(
            redact_sensitive_text("7z a -pmySecret out.7z"),
            "7z a -p***"
        );
        assert_eq!(
            redact_sensitive_text("7z a -PMySecret out.7z"),
            "7z a -p***"
        );
        assert!(!sanitize_output("err -phunter2").contains("hunter2"));
        assert!(
            redact_sensitive_text("7z x -spd -aou archive.7z").contains("-spd"),
            "-spd must not be treated as a password switch"
        );
        // Already-redacted tokens do not force the rest of the line away.
        assert_eq!(
            redact_sensitive_text("7z a -p*** out.7z"),
            "7z a -p*** out.7z"
        );
    }

    #[test]
    fn redact_sensitive_text_masks_key_values() {
        assert_eq!(
            redact_sensitive_text("password=abc passphrase:xyz"),
            "password=*** passphrase:***"
        );
    }

    #[test]
    fn redact_sensitive_text_leaves_unrelated_dash_p_paths() {
        assert_eq!(
            redact_sensitive_text("copy skip-path/file.txt"),
            "copy skip-path/file.txt"
        );
    }
}
