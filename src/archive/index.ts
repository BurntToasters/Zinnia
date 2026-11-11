export {
  looksLikePasswordRequiredError,
  describe7zError,
} from "../error-hints";

export {
  isEncryptedFlag,
  methodLooksEncrypted,
  withPassword,
  buildExtractArgsFor,
  buildCompressionMethodSwitches,
  validateCompressionInputShape,
  buildArgs,
  readSplitSize,
} from "./args";

export { parseArchiveListing } from "./listing";

export {
  sanitizeCommandArgsForPreview,
  buildCommandPreviewText,
  closeCommandPreviewModal,
  copyCommandPreview,
  previewCommand,
} from "./preview";

export {
  renderBrowseTable,
  closeSelectiveExtractModal,
  setSelectiveExtractSearch,
  selectAllVisibleInPicker,
  clearPickerSelection,
  openSelectiveExtractModal,
  syncSelectiveDestinationAfterBrowseChoice,
  syncDestinationWhilePickerOpen,
} from "./browse-ui";

export { renderSelectiveExtractModal } from "./selective-tree-ui";
export { runSelectiveExtractFromModal } from "./selective-run";

export {
  truncateForDialog,
  formatBatchEta,
  type Run7zResult,
  type ArchiveTestResult,
  addFilesToArchive,
  convertArchive,
  runAction,
  runBatchExtract,
  cancelAction,
  testArchive,
  browseArchive,
} from "./ops";
