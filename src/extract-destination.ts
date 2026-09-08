import { invoke } from "@tauri-apps/api/core";
import { isE2eFrontend } from "./e2e-env";
import { confirmChoice } from "./prompt-modal";

export type ExtractDestinationStatus = "missing" | "directory" | "invalid";

/**
 * Validate a destination and warn before merging into an existing directory.
 * The backend still re-checks every target during transactional publication.
 */
export async function confirmExtractDestination(
  destination: string,
): Promise<boolean> {
  if (!destination.trim()) {
    throw new Error("Choose a destination folder.");
  }

  let status: ExtractDestinationStatus;
  try {
    status = await invoke<ExtractDestinationStatus>(
      "inspect_extract_destination",
      { path: destination },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not inspect the extraction destination: ${detail}`);
  }

  if (status === "invalid") {
    throw new Error(
      "Extraction destination must be a real directory, not a file, symbolic link, or reparse point.",
    );
  }
  if (status === "missing") return true;
  if (status !== "directory") {
    throw new Error("Could not determine the extraction destination type.");
  }
  // Unpackaged E2E has no operator for in-app confirms either; inspect already
  // classified the path. Production still shows the webview dialog.
  if (isE2eFrontend()) return true;

  return confirmChoice({
    title: "Destination already exists",
    message:
      "The destination folder already exists. Existing items will be kept, and extracted items with matching names will be renamed. Continue?",
    confirmLabel: "Extract safely",
    cancelLabel: "Cancel",
  });
}
