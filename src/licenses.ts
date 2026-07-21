import { $, escapeHtml, safeHref, trapFocus, releaseFocusTrap } from "./utils";

export interface LicenseEntry {
  licenses: string;
  repository?: string;
  licenseUrl?: string;
  parents?: string;
  licenseText?: string | null;
  licenseTextStatus?: "bundled" | "not-packaged";
  licenseReferences?: Array<{ identifier: string; url: string }>;
}

let licensesTrigger: HTMLElement | null = null;

export function openLicensesModal(trigger?: HTMLElement) {
  licensesTrigger = trigger ?? null;
  const overlay = $("licenses-overlay");
  overlay.hidden = false;
  const modal = overlay.querySelector<HTMLElement>(".modal");
  if (modal) trapFocus(modal);
  void renderLicenses();
}

export function closeLicensesModal() {
  const overlay = $("licenses-overlay");
  overlay.hidden = true;
  const modal = overlay.querySelector<HTMLElement>(".modal");
  if (modal) releaseFocusTrap(modal);
  if (licensesTrigger) {
    licensesTrigger.focus();
    licensesTrigger = null;
  } else {
    document.getElementById("show-licenses")?.focus();
  }
}

async function renderLicenses() {
  const container = $("licenses-list");
  container.textContent = "Loading\u2026";

  try {
    const [npmLicenses, cargoLicenses, sevenZipLicense] = await Promise.all([
      loadLicenseFile("/licenses.json"),
      loadLicenseFile("/licenses-cargo.json"),
      loadTextFile("/7zip-license.txt"),
    ]);
    const data = { ...(npmLicenses ?? {}), ...(cargoLicenses ?? {}) };
    container.innerHTML = "";

    const sevenZipCard = document.createElement("details");
    sevenZipCard.className = "license-card";
    sevenZipCard.innerHTML =
      `<summary class="license-card__header">` +
      `<strong>7-Zip</strong><span class="license-card__tag">LGPL-2.1 / BSD-3-Clause</span>` +
      `</summary>` +
      `<div class="license-card__body">` +
      `<p><a href="https://7-zip.org/" target="_blank" rel="noopener">7-Zip</a> by Igor Pavlov.</p>` +
      `<p>Most code is GNU LGPL; portions use BSD-3-Clause and the unRAR restriction.</p>` +
      `</div>`;
    if (sevenZipLicense) {
      const pre = document.createElement("pre");
      pre.className = "license-card__text";
      pre.textContent = sevenZipLicense;
      sevenZipCard.querySelector(".license-card__body")?.appendChild(pre);
    }
    container.appendChild(sevenZipCard);

    for (const [key, entry] of Object.entries(data)) {
      const card = document.createElement("details");
      card.className = "license-card";

      const href = entry.repository
        ? escapeHtml(safeHref(entry.repository))
        : "";
      const repoLink =
        href && href !== "#"
          ? `<a href="${href}" target="_blank" rel="noopener">${escapeHtml(entry.repository!)}</a>`
          : "N/A";

      card.innerHTML =
        `<summary class="license-card__header">` +
        `<strong>${escapeHtml(key)}</strong><span class="license-card__tag">${escapeHtml(entry.licenses)}</span>` +
        `</summary>` +
        `<div class="license-card__body">${repoLink}</div>`;
      container.appendChild(card);
      if (entry.licenseText) {
        const pre = document.createElement("pre");
        pre.className = "license-card__text";
        pre.textContent = entry.licenseText;
        card.querySelector(".license-card__body")?.appendChild(pre);
      } else if (entry.licenseTextStatus === "not-packaged") {
        const note = document.createElement("p");
        note.textContent =
          "This crate package did not include license text. Declared SPDX terms: ";
        const body = card.querySelector(".license-card__body");
        for (const [index, reference] of (
          entry.licenseReferences ?? []
        ).entries()) {
          if (index > 0) note.append(", ");
          const link = document.createElement("a");
          link.href = safeHref(reference.url);
          link.target = "_blank";
          link.rel = "noopener";
          link.textContent = reference.identifier;
          note.appendChild(link);
        }
        body?.appendChild(note);
      }
    }
  } catch {
    container.textContent = "Failed to load licenses.";
  }
}

async function loadTextFile(path: string): Promise<string | null> {
  const resp = await fetch(path);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

async function loadLicenseFile(
  path: string,
): Promise<Record<string, LicenseEntry> | null> {
  const resp = await fetch(path);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`Invalid payload in ${path}`);
  }
  return data as Record<string, LicenseEntry>;
}
