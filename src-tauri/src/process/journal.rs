//! Cleanup journal I/O, pending-stages registry, and orphan stage cleanup.

mod cleanup_journal;
mod identity;
mod pending;

pub(crate) const MAX_RECOVERY_JOURNAL_BYTES: u64 = 4 * 1024 * 1024;
pub(crate) const MAX_PENDING_STAGES_BYTES: u64 = 4 * 1024 * 1024;
pub(crate) const MAX_MOVE_PLAN_BYTES: u64 = 512 * 1024 * 1024;
pub(crate) const MAX_MOVE_IDENTITY_LOG_BYTES: u64 = 1024 * 1024 * 1024;
pub(crate) const MAX_MOVE_IDENTITY_RECORD_BYTES: usize = 64 * 1024;
pub(crate) const MOVE_IDENTITY_BATCH_RECORDS: usize = 256;

pub(crate) use cleanup_journal::*;
pub(crate) use identity::*;
pub use pending::*;
