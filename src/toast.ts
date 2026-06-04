export type ToastKind = "success" | "info" | "error";

const DEFAULT_DURATION_MS = 3500;
const REGION_ID = "toast-region";

function ensureRegion(): HTMLElement {
  let region = document.getElementById(REGION_ID);
  if (!region) {
    region = document.createElement("div");
    region.id = REGION_ID;
    region.className = "toast-region";
    region.setAttribute("aria-live", "polite");
    region.setAttribute("aria-atomic", "false");
    document.body.appendChild(region);
  }
  return region;
}

export function showToast(
  text: string,
  kind: ToastKind = "info",
  durationMs = DEFAULT_DURATION_MS,
): void {
  const region = ensureRegion();

  const toast = document.createElement("div");
  toast.className = `toast toast--${kind}`;
  toast.setAttribute("role", kind === "error" ? "alert" : "status");
  toast.textContent = text;

  const dismiss = () => {
    toast.classList.add("toast--leaving");
    window.setTimeout(() => toast.remove(), 200);
  };

  toast.addEventListener("click", dismiss);
  region.appendChild(toast);

  if (durationMs > 0) {
    window.setTimeout(dismiss, durationMs);
  }
}
