//! Byte-bounded, UTF-8-safe output buffering helpers.

pub const MAX_OUTPUT_BYTES: usize = 10 * 1024 * 1024;
/// Browse listings are much larger than other 7-Zip output. About 200,000 ZIP
/// entries fit; larger listings are reported as truncated.
pub const MAX_LIST_OUTPUT_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_LOG_ENTRY_BYTES: usize = 16 * 1024;

/// Stdout/stderr cap for a `run_7z` command. Only listings get the larger cap.
pub fn output_limit_for_command(command: Option<&str>) -> usize {
    match command {
        Some("l") => MAX_LIST_OUTPUT_BYTES,
        _ => MAX_OUTPUT_BYTES,
    }
}

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
    redact_sensitive_text(&strip_control_chars(s))
}

pub fn strip_control_chars(s: &str) -> String {
    // Keep `\r`: 7-Zip `-bsp1` rewrites progress on the same line with CR.
    // Stripping it merges updates and breaks raw `7z-progress` listeners.
    s.chars()
        .filter(|c| !c.is_control() || matches!(*c, '\n' | '\t' | '\r'))
        .collect()
}

/// Redact 7-Zip `-p` passwords and common secret key=value forms from log/output text.
pub fn redact_sensitive_text(input: &str) -> String {
    let with_args = redact_password_args(input);
    redact_key_value_secrets(&with_args)
}

fn redact_password_args(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for line in input.split_inclusive('\n') {
        let body = line.strip_suffix('\n').unwrap_or(line);
        match password_switch_start(body) {
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

fn password_switch_start(body: &str) -> Option<usize> {
    for (index, _) in body.char_indices() {
        let rest = &body[index..];
        if !rest
            .get(..2)
            .is_some_and(|switch| switch.eq_ignore_ascii_case("-p"))
        {
            continue;
        }
        if !starts_switch_context(&body[..index]) {
            continue;
        }
        // Fail closed like utils.ts: 7-Zip passwords attach directly to `-p` and
        // may contain spaces, so the rest of the line cannot be shown safely.
        let value = rest[2..].split(char::is_whitespace).next().unwrap_or("");
        if value.trim_end_matches(is_closing_delimiter) != "***" {
            return Some(index);
        }
    }
    None
}

fn starts_switch_context(before: &str) -> bool {
    before.chars().next_back().is_none_or(|prev| {
        prev.is_whitespace()
            || matches!(
                prev,
                '"' | '\'' | '`' | '[' | '(' | '{' | '<' | '=' | ',' | ';'
            )
    })
}

fn is_closing_delimiter(ch: char) -> bool {
    matches!(ch, '"' | '\'' | '`' | ']' | ')' | '}' | '>')
}

const UNSAFE_WARNING_MARKERS: [&str; 10] = [
    "dangerous link",
    "cannot open",
    "cannot create",
    "cannot set length",
    "crc failed",
    "data error",
    "unexpected end",
    "wrong password",
    "unsupported method",
    "no files to process",
];

const ALLOWED_WARNING_MARKERS: [&str; 6] = [
    "cannot set owner",
    "cannot set file attribute",
    "cannot set file time",
    "data after the end of archive",
    "data after the end of the payload data",
    "archive is open with offset",
];

#[derive(Default)]
pub(crate) struct WarningScan {
    unsafe_marker: bool,
    allowed_marker: bool,
    unknown_stdout_line: bool,
}

impl WarningScan {
    pub(crate) fn from_text(stdout: &str) -> Self {
        let mut scan = Self::default();
        for line in stdout.lines() {
            scan.push_line(line);
        }
        scan
    }

    pub(crate) fn push_line(&mut self, line: &str) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return;
        }
        let lower = trimmed.to_ascii_lowercase();
        self.unsafe_marker |= UNSAFE_WARNING_MARKERS
            .iter()
            .any(|marker| lower.contains(marker));
        let allowed = ALLOWED_WARNING_MARKERS
            .iter()
            .any(|marker| lower.contains(marker));
        self.allowed_marker |= allowed;
        // Some builds put warnings on stdout. Normal progress is allowed, but any
        // unknown warning/error-labelled line makes exit 1 fail closed. 7-Zip's
        // summary lines use "Errors:" / "System errors:" (plural), which neither
        // `contains("warning")` nor `starts_with("error:")` catches.
        if (lower.contains("warning")
            || lower.starts_with("error:")
            || lower.starts_with("errors:")
            || lower.starts_with("archives with errors")
            || lower.contains("system error"))
            && !lower.starts_with("warnings:")
            && !is_7zip_warnings_summary(&lower)
            && !allowed
        {
            self.unknown_stdout_line = true;
        }
    }

    pub(crate) fn mark_unscannable(&mut self) {
        self.unknown_stdout_line = true;
    }

    pub(crate) fn metadata_only(&self, stderr: &str) -> bool {
        let stderr_lower = stderr.to_ascii_lowercase();
        let unsafe_hit = self.unsafe_marker
            || UNSAFE_WARNING_MARKERS
                .iter()
                .any(|marker| stderr_lower.contains(marker));
        if unsafe_hit {
            return false;
        }
        let allowed_hit = self.allowed_marker
            || ALLOWED_WARNING_MARKERS
                .iter()
                .any(|marker| stderr_lower.contains(marker));
        if !allowed_hit {
            return false;
        }
        // 7-Zip writes diagnostic detail to stderr. Reject an unfamiliar stderr
        // line even when a known metadata warning also occurred.
        let stderr_has_unknown_line = stderr
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .any(|line| {
                let line = line.to_ascii_lowercase();
                !ALLOWED_WARNING_MARKERS
                    .iter()
                    .any(|marker| line.contains(marker))
            });
        !stderr_has_unknown_line && !self.unknown_stdout_line
    }
}

/// 7-Zip's end-of-run summary, e.g. `Archives with Warnings: 1`. Only that
/// exact shape with a numeric count is exempt; any other "warning" line still
/// fails closed. Expects a lowercased, trimmed line.
fn is_7zip_warnings_summary(line: &str) -> bool {
    line.strip_prefix("archives with warnings: ")
        .is_some_and(|count| !count.is_empty() && count.bytes().all(|byte| byte.is_ascii_digit()))
}

const LISTING_DROPPED_KEYS: [&str; 9] = [
    "CRC",
    "Created",
    "Accessed",
    "Host OS",
    "Characteristics",
    "Comment",
    "Offset",
    "Volume Index",
    "Version",
];

const LISTING_SEPARATOR: &[u8] = b"----------";
const LISTING_KEY_PREFIX_BYTES: usize = "Characteristics = ".len();

#[derive(Default, PartialEq, Eq)]
enum ListingLineState {
    #[default]
    Undecided,
    Keep,
    Drop,
}

#[derive(Default)]
pub struct ListingLineFilter {
    entries: bool,
    state: ListingLineState,
    head: Vec<u8>,
}

impl ListingLineFilter {
    pub fn for_listing_args(args: &[String]) -> Option<Self> {
        if args.first().map(String::as_str) != Some("l") {
            return None;
        }
        let separator = args
            .iter()
            .position(|arg| arg == "--")
            .unwrap_or(args.len());
        args[..separator]
            .iter()
            .any(|arg| arg.eq_ignore_ascii_case("-slt"))
            .then(Self::default)
    }

    pub fn push(&mut self, chunk: &str) -> String {
        let mut out = Vec::with_capacity(chunk.len());
        let mut rest = chunk.as_bytes();
        while !rest.is_empty() {
            match self.state {
                ListingLineState::Keep | ListingLineState::Drop => {
                    let end = rest
                        .iter()
                        .position(|&byte| byte == b'\n')
                        .map_or(rest.len(), |index| index + 1);
                    if self.state == ListingLineState::Keep {
                        out.extend_from_slice(&rest[..end]);
                    }
                    if rest[end - 1] == b'\n' {
                        self.state = ListingLineState::Undecided;
                    }
                    rest = &rest[end..];
                }
                ListingLineState::Undecided => {
                    let mut take = rest.len().min(LISTING_KEY_PREFIX_BYTES - self.head.len());
                    while take < rest.len() && (rest[take] & 0xC0) == 0x80 {
                        take += 1;
                    }
                    match rest[..take].iter().position(|&byte| byte == b'\n') {
                        Some(index) => {
                            self.head.extend_from_slice(&rest[..index]);
                            rest = &rest[index + 1..];
                            self.decide(&mut out, true);
                        }
                        None => {
                            self.head.extend_from_slice(&rest[..take]);
                            rest = &rest[take..];
                            if self.head.len() >= LISTING_KEY_PREFIX_BYTES {
                                self.decide(&mut out, false);
                            }
                        }
                    }
                }
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    pub fn finish(&mut self) -> String {
        let mut out = Vec::new();
        if self.state == ListingLineState::Undecided && !self.head.is_empty() {
            self.decide(&mut out, false);
        }
        self.state = ListingLineState::Undecided;
        self.head.clear();
        String::from_utf8_lossy(&out).into_owned()
    }

    fn decide(&mut self, out: &mut Vec<u8>, terminated: bool) {
        if self.entries && listing_line_is_dropped(&self.head) {
            self.head.clear();
            self.state = if terminated {
                ListingLineState::Undecided
            } else {
                ListingLineState::Drop
            };
            return;
        }
        out.extend_from_slice(&self.head);
        if terminated {
            out.push(b'\n');
            let content = self.head.strip_suffix(b"\r").unwrap_or(&self.head[..]);
            if !self.entries && content == LISTING_SEPARATOR {
                self.entries = true;
            }
            self.head.clear();
            self.state = ListingLineState::Undecided;
        } else {
            self.head.clear();
            self.state = ListingLineState::Keep;
        }
    }
}

fn listing_line_is_dropped(line: &[u8]) -> bool {
    LISTING_DROPPED_KEYS.iter().any(|key| {
        let key = key.as_bytes();
        line.starts_with(key) && line[key.len()..].starts_with(b" = ")
    })
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
mod listing_limit_tests {
    use super::*;

    #[test]
    fn only_listing_commands_get_the_larger_browse_cap() {
        assert_eq!(MAX_LIST_OUTPUT_BYTES, 64 * 1024 * 1024);
        assert_eq!(output_limit_for_command(Some("l")), MAX_LIST_OUTPUT_BYTES);
        assert_eq!(output_limit_for_command(Some("x")), MAX_OUTPUT_BYTES);
        assert_eq!(output_limit_for_command(Some("t")), MAX_OUTPUT_BYTES);
        assert_eq!(output_limit_for_command(Some("a")), MAX_OUTPUT_BYTES);
        assert_eq!(output_limit_for_command(None), MAX_OUTPUT_BYTES);
    }
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

    #[test]
    fn redact_password_switch_after_quote_or_bracket() {
        let quoted = redact_sensitive_text("debug [\"-psecret\"]");
        assert_eq!(quoted, "debug [\"-p***");
        assert!(!quoted.contains("secret"));
        assert_eq!(redact_sensitive_text("echo \"-psecret\""), "echo \"-p***");
        assert_eq!(redact_sensitive_text("argv=['-psecret']"), "argv=['-p***");
        assert_eq!(redact_sensitive_text("[-psecret]"), "[-p***");
        assert_eq!(redact_sensitive_text("x=-PSecret"), "x=-p***");
        assert_eq!(redact_sensitive_text("7z a -p"), "7z a -p***");
    }

    #[test]
    fn redact_password_switch_cuts_rest_of_line_even_with_spaces() {
        assert_eq!(redact_sensitive_text("7z a \"-pa b\" out"), "7z a \"-p***");
    }

    #[test]
    fn redact_leaves_mid_word_dash_p_alone() {
        for text in [
            "copy skip-path/file.txt",
            "copy a-pb.txt",
            "dir\\-pfoo",
            "dir/-pfoo",
            "é-psecret",
            "file-p.txt",
        ] {
            assert_eq!(redact_sensitive_text(text), text);
        }
    }

    #[test]
    fn redact_keeps_already_redacted_switch_with_closing_delimiter() {
        assert_eq!(
            redact_sensitive_text("argv [\"-p***\"]"),
            "argv [\"-p***\"]"
        );
        assert_eq!(
            redact_sensitive_text("7z a -p*** out.7z"),
            "7z a -p*** out.7z"
        );
        let once = redact_sensitive_text("run ['-psecret']");
        assert_eq!(redact_sensitive_text(&once), once);
    }

    #[test]
    fn redact_password_switch_per_line_keeps_newlines() {
        assert_eq!(
            redact_sensitive_text("a \"-psecret\"\nb c\n"),
            "a \"-p***\nb c\n"
        );
    }
}

#[cfg(test)]
mod listing_filter_tests {
    use super::*;

    const DROPPED_KEYS: [&str; 9] = [
        "CRC",
        "Created",
        "Accessed",
        "Host OS",
        "Characteristics",
        "Comment",
        "Offset",
        "Volume Index",
        "Version",
    ];

    fn listing_args() -> Vec<String> {
        ["l", "-slt", "-spd", "--", "a.zip"]
            .map(str::to_string)
            .to_vec()
    }

    fn filter() -> ListingLineFilter {
        ListingLineFilter::for_listing_args(&listing_args()).expect("listing with -slt")
    }

    fn filtered_whole(input: &str) -> String {
        let mut filter = filter();
        let mut out = filter.push(input);
        out.push_str(&filter.finish());
        out
    }

    fn filtered_in_two_chunks(input: &str, split: usize) -> String {
        let mut filter = filter();
        let mut out = filter.push(&input[..split]);
        out.push_str(&filter.push(&input[split..]));
        out.push_str(&filter.finish());
        out
    }

    fn filtered_char_by_char(input: &str) -> String {
        let mut filter = filter();
        let mut out = String::new();
        for (index, ch) in input.char_indices() {
            out.push_str(&filter.push(&input[index..index + ch.len_utf8()]));
        }
        out.push_str(&filter.finish());
        out
    }

    const HEADER_AND_ENTRIES: &str = "\n7-Zip 26.06 (x64)\n\nListing archive: a.zip\n\n--\nPath = a.zip\nType = zip\nCRC = header-kept\nVersion = header-kept\n\n----------\nPath = dir/first.txt\nFolder = -\nSize = 5\nPacked Size = 5\nModified = 2026-01-01 00:00:00\nCreated = \nAccessed = \nAttributes = A\nEncrypted = -\nComment = dropped\nCRC = 1234ABCD\nMethod = Store\nCharacteristics = NTFS\nHost OS = FAT\nVersion = 20\nVolume Index = 0\nOffset = 0\n\nPath = dir/sub/é-日本.txt\nSize = 7\nOffset = 46\n\n";

    const HEADER_AND_ENTRIES_FILTERED: &str = "\n7-Zip 26.06 (x64)\n\nListing archive: a.zip\n\n--\nPath = a.zip\nType = zip\nCRC = header-kept\nVersion = header-kept\n\n----------\nPath = dir/first.txt\nFolder = -\nSize = 5\nPacked Size = 5\nModified = 2026-01-01 00:00:00\nAttributes = A\nEncrypted = -\nMethod = Store\n\nPath = dir/sub/é-日本.txt\nSize = 7\n\n";

    #[test]
    fn listing_filter_keeps_archive_header_block_untouched() {
        let header =
            "--\nPath = a.zip\nCRC = kept\nVersion = kept\nComment = kept\nHost OS = kept\n\n";
        let input = format!("{header}----------\nPath = a\nCRC = gone\n");
        let filtered = filtered_whole(&input);
        assert!(filtered.starts_with(header), "{filtered:?}");
        assert!(!filtered.contains("CRC = gone"));
    }

    #[test]
    fn listing_filter_drops_only_the_nine_unread_keys_after_separator() {
        assert_eq!(
            filtered_whole(HEADER_AND_ENTRIES),
            HEADER_AND_ENTRIES_FILTERED
        );
        for key in DROPPED_KEYS {
            let input = format!("----------\n{key} = x\nPath = a\n");
            assert_eq!(filtered_whole(&input), "----------\nPath = a\n", "{key}");
        }
    }

    #[test]
    fn listing_filter_keeps_kept_keys_and_order() {
        let input = "----------\nPath = a\nSize = 1\nPacked Size = 2\nModified = m\nFolder = -\nAttributes = A\nEncrypted = -\nMethod = Store\n";
        assert_eq!(filtered_whole(input), input);
    }

    #[test]
    fn listing_filter_key_lookalikes_are_kept() {
        let input = "----------\nCRCX = 1\nVersion2 = 1\nCRC=1\nHost  OS = x\n CRC = 1\ncrc = 1\nComment: x\nOffset = 0\n";
        let expected = "----------\nCRCX = 1\nVersion2 = 1\nCRC=1\nHost  OS = x\n CRC = 1\ncrc = 1\nComment: x\n";
        assert_eq!(filtered_whole(input), expected);
    }

    #[test]
    fn listing_filter_separator_must_be_the_exact_dash_line() {
        let not_separator = "----------x\nCRC = kept\n";
        assert_eq!(filtered_whole(not_separator), not_separator);
        let with_space = "  ----------\nCRC = kept\n";
        assert_eq!(filtered_whole(with_space), with_space);
        let exact = "----------\r\nCRC = gone\r\n";
        assert_eq!(filtered_whole(exact), "----------\r\n");
    }

    #[test]
    fn listing_filter_is_chunk_invariant_at_every_split() {
        let whole = filtered_whole(HEADER_AND_ENTRIES);
        for (index, _) in HEADER_AND_ENTRIES.char_indices() {
            assert_eq!(
                filtered_in_two_chunks(HEADER_AND_ENTRIES, index),
                whole,
                "split at byte {index}"
            );
        }
        assert_eq!(filtered_char_by_char(HEADER_AND_ENTRIES), whole);
    }

    #[test]
    fn listing_filter_is_chunk_invariant_inside_multibyte_paths() {
        let input = "----------\nPath = 日本/é/ñ.txt\nCRC = 日本語\nSize = 3\n";
        let whole = filtered_whole(input);
        assert_eq!(whole, "----------\nPath = 日本/é/ñ.txt\nSize = 3\n");
        for (index, _) in input.char_indices() {
            assert_eq!(
                filtered_in_two_chunks(input, index),
                whole,
                "split at {index}"
            );
        }
    }

    #[test]
    fn listing_filter_flushes_unterminated_last_line() {
        assert_eq!(
            filtered_whole("----------\nPath = a\nCRC = 5"),
            "----------\nPath = a\n"
        );
        assert_eq!(
            filtered_whole("----------\nPath = a\nSize = 5"),
            "----------\nPath = a\nSize = 5"
        );
    }

    #[test]
    fn listing_filter_keeps_crlf_on_kept_lines_and_drops_whole_lines() {
        assert_eq!(
            filtered_whole("----------\r\nPath = a\r\nCRC = 5\r\nSize = 1\r\n"),
            "----------\r\nPath = a\r\nSize = 1\r\n"
        );
    }

    #[test]
    fn listing_filter_applies_only_to_listing_with_slt() {
        let args = |items: &[&str]| {
            items
                .iter()
                .map(|item| item.to_string())
                .collect::<Vec<_>>()
        };
        assert!(
            ListingLineFilter::for_listing_args(&args(&["l", "-slt", "--", "a.zip"])).is_some()
        );
        assert!(
            ListingLineFilter::for_listing_args(&args(&["l", "-SLT", "--", "a.zip"])).is_some()
        );
        assert!(
            ListingLineFilter::for_listing_args(&args(&["l", "-spd", "--", "a.zip"])).is_none()
        );
        assert!(
            ListingLineFilter::for_listing_args(&args(&["x", "-slt", "--", "a.zip"])).is_none()
        );
        assert!(
            ListingLineFilter::for_listing_args(&args(&["t", "-slt", "--", "a.zip"])).is_none()
        );
        assert!(
            ListingLineFilter::for_listing_args(&args(&["a", "-slt", "--", "out.zip", "f"]))
                .is_none()
        );
        assert!(ListingLineFilter::for_listing_args(&args(&["l", "--", "-slt"])).is_none());
        assert!(ListingLineFilter::for_listing_args(&args(&["l", "-slt", "--", "-slt"])).is_some());
    }

    #[test]
    fn listing_filter_passes_text_through_when_no_entry_section_exists() {
        let input = "CRC = 1\nComment = 2\n";
        assert_eq!(filtered_whole(input), input);
    }
}
