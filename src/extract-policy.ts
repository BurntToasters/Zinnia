/**
 * Extract overwrite policy — determines how 7z handles name collisions during extraction.
 * `-aou` = auto-rename extracted files if they collide with existing files at the destination.
 *
 * NOTE: This module does NOT provide zip-slip/path-traversal or decompression-bomb protection.
 * Path traversal is blocked by the Rust validation layer (validation.rs) which rejects `..`
 * components. Archive *content* containment (symlinks, absolute member paths) relies on 7z's
 * own protections combined with the mandatory `-o<dir>` extraction destination.
 */
export const SAFE_EXTRACT_OVERWRITE_MODE = "-aou";
