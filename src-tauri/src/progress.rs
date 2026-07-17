//! Parse 7z stdout progress lines, e.g. ` 23% 5 + path/file.txt`, ` 45%`.

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

    let percent_end = segment.find('%')?;
    let percent_str = segment[..percent_end].trim();
    if percent_str.is_empty() || !percent_str.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let percent: u16 = percent_str.parse().ok()?;
    if percent > 100 {
        return None;
    }

    let mut update = ProgressUpdate {
        percent: Some(percent as u8),
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

    if !name.is_empty() {
        update.current_file = Some(name.to_string());
    }
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
    fn takes_latest_state_after_carriage_returns() {
        let u = parse_progress_line("\r 10% a.txt\r 80% + b.txt").expect("should parse");
        assert_eq!(u.percent, Some(80));
        assert_eq!(u.current_file.as_deref(), Some("b.txt"));
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
}
