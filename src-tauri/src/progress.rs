//! Parse 7z stdout progress lines, e.g. ` 23% 5 + path/file.txt`, ` 45%`,
//! `Progress: 45%`, `Total percent: 80%`.

#[derive(serde::Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProgressUpdate {
    pub percent: Option<u8>,
    pub files_done: Option<u64>,
    pub current_file: Option<String>,
}

impl ProgressUpdate {
    fn is_empty(&self) -> bool {
        self.percent.is_none() && self.files_done.is_none() && self.current_file.is_none()
    }
}

pub fn parse_progress_line(line: &str) -> Option<ProgressUpdate> {
    // 7z rewrites the line with '\r'; take the latest segment.
    let segment = line
        .rsplit(['\r', '\n'])
        .find(|s| !s.trim().is_empty())
        .unwrap_or("")
        .trim_start();

    let (percent, percent_end) = find_percent_token(segment)?;

    let mut update = ProgressUpdate {
        percent: Some(percent),
        ..Default::default()
    };

    let rest = segment[percent_end + 1..].trim_start();
    let rest = parse_files_done(rest, &mut update);
    parse_current_file(rest, &mut update);

    if update.is_empty() {
        None
    } else {
        Some(update)
    }
}

/// Locate the first valid `0…100%` token (supports `Progress: 45%` prefixes).
fn find_percent_token(segment: &str) -> Option<(u8, usize)> {
    let bytes = segment.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if i < bytes.len() && bytes[i] == b'%' {
                let percent_str = &segment[start..i];
                if let Ok(percent) = percent_str.parse::<u16>() {
                    if percent <= 100 {
                        return Some((percent as u8, i));
                    }
                }
            }
        } else {
            i += 1;
        }
    }
    None
}

fn parse_files_done<'a>(rest: &'a str, update: &mut ProgressUpdate) -> &'a str {
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return rest;
    }
    if let Ok(count) = digits.parse::<u64>() {
        update.files_done = Some(count);
    }
    rest[digits.len()..].trim_start()
}

fn parse_current_file(rest: &str, update: &mut ProgressUpdate) {
    let trimmed = rest.trim();
    if trimmed.is_empty() {
        return;
    }

    // Strip a leading action marker (+ - = U).
    let name = match trimmed.chars().next() {
        Some(marker @ ('+' | '-' | '=' | 'U')) => trimmed[marker.len_utf8()..].trim_start(),
        _ => trimmed,
    };

    if let Some(clean) = sanitize_progress_filename(name) {
        update.current_file = Some(clean);
    }
}

/// Drop controls/bidi/replacement junk and leading non-name symbols so the UI
/// never flashes tofu boxes from partial or noisy 7-Zip progress chunks.
fn sanitize_progress_filename(name: &str) -> Option<String> {
    let cleaned: String = name
        .chars()
        .filter(|c| {
            !c.is_control()
                && *c != '\u{fffd}'
                && *c != '\u{feff}'
                && !matches!(
                    *c,
                    '\u{200b}'..='\u{200f}'
                        | '\u{202a}'..='\u{202e}'
                        | '\u{2060}'..='\u{2064}'
                )
        })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Prefer the first path-like character so symbol runs like "░░░░ ░░░░- name"
    // become "name", while still keeping ".hidden" / "_tmp" names.
    let start = trimmed
        .char_indices()
        .find(|(_, c)| c.is_alphanumeric() || matches!(*c, '.' | '_' | '~'))
        .map(|(i, _)| i)?;
    let meaningful = trimmed[start..].trim();
    if meaningful.is_empty() {
        return None;
    }
    const MAX_PROGRESS_FILENAME_CHARS: usize = 200;
    let capped: String = meaningful
        .chars()
        .take(MAX_PROGRESS_FILENAME_CHARS)
        .collect();
    Some(capped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_percent_count_and_file() {
        let u = parse_progress_line(" 23% 5 + path/to/file.txt").expect("should parse");
        assert_eq!(u.percent, Some(23));
        assert_eq!(u.files_done, Some(5));
        assert_eq!(u.current_file.as_deref(), Some("path/to/file.txt"));
    }

    #[test]
    fn parses_percent_with_action_marker_only() {
        let u = parse_progress_line("  7% - folder/name.bin").expect("should parse");
        assert_eq!(u.percent, Some(7));
        assert_eq!(u.files_done, None);
        assert_eq!(u.current_file.as_deref(), Some("folder/name.bin"));
    }

    #[test]
    fn parses_bare_percent() {
        let u = parse_progress_line(" 45%").expect("should parse");
        assert_eq!(u.percent, Some(45));
        assert_eq!(u.files_done, None);
        assert_eq!(u.current_file, None);
    }

    #[test]
    fn parses_progress_label_shapes() {
        let u = parse_progress_line("Progress: 45%").expect("should parse");
        assert_eq!(u.percent, Some(45));
        let u = parse_progress_line("Total percent: 80%").expect("should parse");
        assert_eq!(u.percent, Some(80));
    }

    #[test]
    fn takes_latest_state_after_carriage_returns() {
        let u = parse_progress_line("\r 10% a.txt\r 80% + b.txt").expect("should parse");
        assert_eq!(u.percent, Some(80));
        assert_eq!(u.current_file.as_deref(), Some("b.txt"));
    }

    #[test]
    fn parses_percent_after_carriage_return_framing() {
        assert_eq!(parse_progress_line("0%\r").and_then(|u| u.percent), Some(0));
        assert!(parse_progress_line("T hello.txt\r").is_none());
        assert_eq!(
            parse_progress_line("100%\r").and_then(|u| u.percent),
            Some(100)
        );
        assert!(parse_progress_line("Everything is Ok\r\n").is_none());
    }

    #[test]
    fn ignores_non_progress_lines() {
        assert!(parse_progress_line("7-Zip 26.01 (arm64)").is_none());
        assert!(parse_progress_line("Everything is Ok").is_none());
        assert!(parse_progress_line("").is_none());
        assert!(parse_progress_line("Scanning the drive:").is_none());
    }

    #[test]
    fn rejects_out_of_range_percent() {
        assert!(parse_progress_line("999% nope").is_none());
    }

    #[test]
    fn keeps_filenames_containing_percent_sign() {
        let u = parse_progress_line(" 50% 2 + weird%name.txt").expect("should parse");
        assert_eq!(u.percent, Some(50));
        assert_eq!(u.current_file.as_deref(), Some("weird%name.txt"));
    }

    #[test]
    fn strips_leading_symbol_junk_before_filename() {
        let u = parse_progress_line(" 3% - \u{2591}\u{2591}\u{2591}\u{2591} \u{2591}\u{2591}\u{2591}\u{2591}- insurance 2026.pdf")
            .expect("should parse");
        assert_eq!(u.current_file.as_deref(), Some("insurance 2026.pdf"));
    }

    #[test]
    fn keeps_unicode_letters_in_filenames() {
        let u = parse_progress_line(" 10% - 报告.pdf").expect("should parse");
        assert_eq!(u.current_file.as_deref(), Some("报告.pdf"));
    }

    #[test]
    fn drops_filenames_that_are_only_junk() {
        let u = parse_progress_line(" 10% - \u{fffd}\u{fffd}").expect("should parse");
        assert_eq!(u.percent, Some(10));
        assert_eq!(u.current_file, None);
    }

    #[test]
    fn caps_long_progress_filenames() {
        let long = format!(" 10% - {}", "a".repeat(300));
        let u = parse_progress_line(&long).expect("should parse");
        assert_eq!(u.current_file.as_ref().map(String::len), Some(200));
    }
}
