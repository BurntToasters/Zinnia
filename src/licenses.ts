import { $, escapeHtml, safeHref, trapFocus, releaseFocusTrap } from "./utils";

export interface LicenseEntry {
  licenses: string;
  repository?: string;
  licenseUrl?: string;
  parents?: string;
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
    const [npmLicenses, cargoLicenses] = await Promise.all([
      loadLicenseFile("/licenses.json"),
      loadLicenseFile("/licenses-cargo.json"),
    ]);
    const data = { ...(npmLicenses ?? {}), ...(cargoLicenses ?? {}) };
    container.innerHTML = "";

    const twemojiCard = document.createElement("details");
    twemojiCard.className = "license-card";
    twemojiCard.innerHTML =
      `<summary class="license-card__header">` +
      `<strong>Twemoji</strong><span class="license-card__tag">CC-BY-4.0 / MIT</span>` +
      `</summary>` +
      `<div class="license-card__body">` +
      `<p>Emoji graphics by <a href="https://github.com/jdecked/twemoji" target="_blank" rel="noopener">jdecked/twemoji</a>, ` +
      `licensed under <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC-BY 4.0</a>.</p>` +
      `<p>Code licensed under <a href="https://opensource.org/licenses/MIT" target="_blank" rel="noopener">MIT</a>.</p>` +
      `<p>Copyright 2019 Twitter, Inc and other contributors.<br/>Copyright 2024 jdecked and other contributors.</p>` +
      `</div>`;
    container.appendChild(twemojiCard);

    const sevenZipCard = document.createElement("details");
    sevenZipCard.className = "license-card";
    sevenZipCard.innerHTML =
      `<summary class="license-card__header">` +
      `<strong>7-Zip</strong><span class="license-card__tag">LGPL-2.1 / BSD-3-Clause</span>` +
      `</summary>` +
      `<div class="license-card__body">` +
      `<p><a href="https://7-zip.org/" target="_blank" rel="noopener">7-Zip</a> by Igor Pavlov.</p>` +
      `<p>Most of the code is under the GNU LGPL license. Some parts are under the BSD 3-clause license. ` +
      `There is also unRAR license restriction for some parts of the code.</p>` +
      `</div>`;
    container.appendChild(sevenZipCard);

    for (const [key, entry] of Object.entries(data)) {
      const card = document.createElement("details");
      card.className = "license-card";

      const href = entry.repository ? safeHref(entry.repository) : "";
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
    }
  } catch {
    container.textContent = "Failed to load licenses.";
  }
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
