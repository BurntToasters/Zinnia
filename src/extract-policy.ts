/**
 * Extract overwrite policy — determines how 7z handles name collisions during extraction.
 * `-aou` = auto-rename extracted files if they collide with existing files at the destination.
 *
 * NOTE: This module does not by itself provide archive-member path policy or
 * decompression-bomb limits. Argument validation and the mandatory output directory
 * protect the process boundary; content-level protection is enforced by staged extraction.
 */
export const SAFE_EXTRACT_OVERWRITE_MODE = "-aou";
