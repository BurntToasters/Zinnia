import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import {
  parseSltMemberPaths,
  requireHostSidecar,
  run7z,
} from "../../scripts/archive-fixtures.js";
import {
  applyIncomingPaths,
  confirmSelectiveExtract,
  expandSelectiveFolder,
  hasSelectiveMember,
  openBrowseArchive,
  openSelectiveExtractPicker,
  setCheckbox,
  setInputValue,
  setSelectValue,
  switchToPowerWorkspace,
  toggleSelectiveMember,
  uiDiagnostics,
  waitForArchiveIdle,
  waitForE2eHook,
  waitForMainWindow,
} from "../helpers/ui-driver.js";
import { writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;
const WORK = process.env.ZINNIA_E2E_WORK;
const ROOT = path.join(WORK, "audit-argv");
const sidecar = requireHostSidecar();
const BULK_FILE_COUNT = 9_000;

function mkdirFresh(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

/** Sorted relative file paths under root, POSIX separators. */
function walkFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const walk = (dir, relative) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const next = relative ? `${relative}/${name}` : name;
      if (fs.lstatSync(full).isDirectory()) walk(full, next);
      else out.push(next);
    }
  };
  walk(root, "");
  return out.sort();
}

function listMemberNames(archive) {
  return parseSltMemberPaths(
    run7z(sidecar, ["l", "-slt", "--", archive]).stdout,
  );
}

/**
 * Power compress with several inputs. `startPowerCompress` in the shared
 * helpers takes one input, so this mirrors its steps for a list.
 */
async function startPowerCompressInputs(inputs, output) {
  await switchToPowerWorkspace();
  await browser.execute(() => {
    document.querySelector('[data-mode-btn="add"]')?.click();
  });
  await waitForArchiveIdle();
  await browser.execute(() => {
    document.getElementById("clear-inputs")?.click();
  });
  await applyIncomingPaths(inputs, "compress");
  await setCheckbox("#encrypt-headers", false);
  await setCheckbox("#update-mode", false);
  await setSelectValue("#split-size", "");
  await setInputValue("#output-path", output);
  await browser.execute(() => {
    document.getElementById("run-action")?.click();
  });
}

describe("audit-argv list-file names and member limits", function () {
  this.timeout(10 * 60_000);

  before(async () => {
    await waitForMainWindow();
    await waitForE2eHook();
    fs.mkdirSync(ROOT, { recursive: true });
  });

  it("compresses names with trailing, leading, and quote characters exactly", async function () {
    if (process.platform === "win32") this.skip();
    const tree = path.join(ROOT, "compress-names-src");
    mkdirFresh(tree);
    const contents = {
      "report ": "trailing\n",
      report: "sibling\n",
      " lead.txt": "lead\n",
      '"quoted"': "quoted-literal\n",
      quoted: "sibling-quoted\n",
    };
    for (const [name, body] of Object.entries(contents)) {
      fs.writeFileSync(path.join(tree, name), body);
    }
    const inputs = Object.keys(contents).map((name) => path.join(tree, name));
    const output = path.join(ROOT, "compress-names.7z");
    fs.rmSync(output, { force: true });

    await startPowerCompressInputs(inputs, output);
    await browser.waitUntil(() => fs.existsSync(output), {
      timeout: 120_000,
      timeoutMsg: `compress did not write ${output}; ${await uiDiagnostics()}`,
    });
    await waitForArchiveIdle();

    const members = listMemberNames(output).sort();
    assert.deepEqual(
      members,
      Object.keys(contents).sort(),
      "archive must hold exactly the selected names",
    );

    const extractDir = path.join(ROOT, "compress-names-out");
    mkdirFresh(extractDir);
    run7z(sidecar, ["x", `-o${extractDir}`, "-aou", "-spd", "--", output]);
    for (const [name, body] of Object.entries(contents)) {
      assert.equal(
        fs.readFileSync(path.join(extractDir, name), "utf8"),
        body,
        `member ${JSON.stringify(name)} holds the wrong content`,
      );
    }

    writeEvidence(EVIDENCE_DIR, "audit-argv-compress-exact-names", {
      scenario: "audit-argv-compress-exact-names",
      output,
      members,
    });
  });

  it("selectively extracts literal names with spaces, dashes, and @", async function () {
    if (process.platform === "win32") this.skip();
    const tree = path.join(ROOT, "selective-names-src");
    mkdirFresh(tree);
    fs.writeFileSync(path.join(tree, "report "), "trailing\n");
    fs.writeFileSync(path.join(tree, "report"), "sibling\n");
    fs.mkdirSync(path.join(tree, "-web"));
    fs.writeFileSync(path.join(tree, "-web", "app.js"), "app\n");
    fs.writeFileSync(path.join(tree, "-web", "skip.js"), "skip\n");
    fs.writeFileSync(path.join(tree, "-work.txt"), "work\n");
    fs.writeFileSync(path.join(tree, "-sidebar.png"), "sidebar\n");
    fs.mkdirSync(path.join(tree, "-icons"));
    fs.writeFileSync(path.join(tree, "-icons", "@2x.png"), "retina\n");
    fs.writeFileSync(path.join(tree, "-icons", "skip.png"), "skip\n");
    fs.writeFileSync(path.join(tree, "skipped.txt"), "skipped\n");
    const archive = path.join(ROOT, "selective-names.7z");
    fs.rmSync(archive, { force: true });
    run7z(
      sidecar,
      [
        "a",
        "-t7z",
        archive,
        "--",
        "./report ",
        "./report",
        "./-web",
        "./-work.txt",
        "./-sidebar.png",
        "./-icons",
        "skipped.txt",
      ],
      { cwd: tree },
    );
    const dest = path.join(ROOT, "selective-names-out");
    mkdirFresh(dest);

    const selected = [
      "report ",
      "-web/app.js",
      "-work.txt",
      "-sidebar.png",
      "-icons/@2x.png",
    ];
    await openBrowseArchive(archive, "report");
    await openSelectiveExtractPicker();
    await toggleSelectiveMember("report ");
    await expandSelectiveFolder("-web");
    await browser.waitUntil(() => hasSelectiveMember("-web/app.js"), {
      timeout: 10_000,
      timeoutMsg: "selective tree did not show -web/app.js",
    });
    await toggleSelectiveMember("-web/app.js");
    await toggleSelectiveMember("-work.txt");
    await toggleSelectiveMember("-sidebar.png");
    await expandSelectiveFolder("-icons");
    await browser.waitUntil(() => hasSelectiveMember("-icons/@2x.png"), {
      timeout: 10_000,
      timeoutMsg: "selective tree did not show -icons/@2x.png",
    });
    await toggleSelectiveMember("-icons/@2x.png");
    await confirmSelectiveExtract(dest);

    await browser.waitUntil(() => walkFiles(dest).length >= selected.length, {
      timeout: 120_000,
      timeoutMsg: `selective extract did not publish members; ${await uiDiagnostics()}`,
    });
    await waitForArchiveIdle();

    const extracted = walkFiles(dest);
    assert.deepEqual(
      extracted,
      [...selected].sort(),
      "selective extract must write exactly the selected members",
    );
    assert.equal(
      fs.readFileSync(path.join(dest, "report "), "utf8"),
      "trailing\n",
      "report  (trailing space) was replaced by a different member",
    );

    writeEvidence(EVIDENCE_DIR, "audit-argv-selective-literal-names", {
      scenario: "audit-argv-selective-literal-names",
      archive,
      destination: dest,
      selected,
      extracted,
    });
  });

  it("selectively extracts a folder holding 9,000 files", async () => {
    const tree = path.join(ROOT, "bulk-src");
    mkdirFresh(path.join(tree, "bulk"));
    for (let index = 1; index <= BULK_FILE_COUNT; index += 1) {
      const name = `file-${String(index).padStart(5, "0")}.txt`;
      fs.writeFileSync(path.join(tree, "bulk", name), `${index}\n`);
    }
    const archive = path.join(ROOT, "bulk.7z");
    fs.rmSync(archive, { force: true });
    run7z(sidecar, ["a", "-t7z", archive, "--", "bulk"], { cwd: tree });
    const dest = path.join(ROOT, "bulk-out");
    mkdirFresh(dest);

    await openBrowseArchive(archive, "bulk");
    await openSelectiveExtractPicker();
    await toggleSelectiveMember("bulk");
    await confirmSelectiveExtract(dest);

    await browser.waitUntil(() => walkFiles(dest).length >= BULK_FILE_COUNT, {
      timeout: 8 * 60_000,
      interval: 1_000,
      timeoutMsg: `folder extract did not publish ${BULK_FILE_COUNT} files; ${await uiDiagnostics()}`,
    });
    await waitForArchiveIdle();

    const extracted = walkFiles(dest);
    assert.equal(
      extracted.length,
      BULK_FILE_COUNT,
      `expected ${BULK_FILE_COUNT} extracted files, got ${extracted.length}`,
    );
    assert.equal(
      fs.readFileSync(path.join(dest, "bulk", "file-09000.txt"), "utf8"),
      "9000\n",
    );

    writeEvidence(EVIDENCE_DIR, "audit-argv-selective-9000-folder", {
      scenario: "audit-argv-selective-9000-folder",
      archive,
      destination: dest,
      selectedFolder: "bulk",
      extractedCount: extracted.length,
    });
  });
});
