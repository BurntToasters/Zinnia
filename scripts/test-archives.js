import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CREATE_MATRIX,
  ZIPS_DIR,
  findMemberFile,
  loadArchiveManifest,
  makeTempDir,
  randomBytesFile,
  requireHostSidecar,
  run7z,
  walkFiles,
} from "./archive-fixtures.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function extractArchive(
  sidecar,
  archivePath,
  dest,
  extraArgs = [],
  allowFailure = false,
) {
  fs.mkdirSync(dest, { recursive: true });
  return run7z(
    sidecar,
    ["x", `-o${dest}`, "-aou", ...extraArgs, "--", archivePath],
    { allowFailure },
  );
}

function twoStepCompoundExtract(sidecar, archivePath, dest) {
  const outer = makeTempDir("compound-outer");
  try {
    extractArchive(sidecar, archivePath, outer);
    const tar = findMemberFile(outer, "hello.tar");
    assert(
      tar,
      `compound outer extract of ${path.basename(archivePath)} did not yield hello.tar`,
    );
    extractArchive(sidecar, tar, dest);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
}

function assertPayload(extractRoot, memberPath, expectedText) {
  const found = findMemberFile(extractRoot, memberPath);
  if (found && fs.readFileSync(found, "utf8") === expectedText) {
    return;
  }
  const extractedFiles = walkFiles(extractRoot).filter((file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
  const contentMatch = extractedFiles.filter(
    (file) => fs.readFileSync(file, "utf8") === expectedText,
  );
  if (contentMatch.length === 1) {
    return;
  }
  const names = extractedFiles
    .map((file) => path.relative(extractRoot, file))
    .join(", ");
  throw new Error(
    `missing member ${memberPath}; extracted: ${names || "(empty)"}`,
  );
}

function testIntegrityAndExtract(sidecar, manifest) {
  const password = manifest.password;
  for (const entry of manifest.extract) {
    const archivePath = path.join(ZIPS_DIR, entry.file);
    assert(fs.existsSync(archivePath), `missing fixture ${entry.file}`);
    const extra = entry.password ? [`-p${password}`] : [];
    run7z(sidecar, ["t", ...extra, "--", archivePath]);

    const dest = makeTempDir(`extract-${entry.file.replaceAll(".", "-")}`);
    try {
      if (entry.compoundTar) {
        twoStepCompoundExtract(sidecar, archivePath, dest);
      } else {
        extractArchive(sidecar, archivePath, dest, extra);
      }
      for (const member of entry.members) {
        assertPayload(dest, member, manifest.payloadText);
      }
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    console.log(`  extract ${entry.file}`);
  }

  for (const entry of manifest.extract.filter((item) => item.password)) {
    const archivePath = path.join(ZIPS_DIR, entry.file);
    const wrong = run7z(sidecar, ["t", "-pwrong-password", "--", archivePath], {
      allowFailure: true,
    });
    assert(
      wrong.code !== 0,
      `${entry.file} integrity test succeeded with the wrong password`,
    );
    console.log(`  wrong-password ${entry.file}`);
  }
}

function testNegatives(sidecar, manifest) {
  for (const entry of manifest.negative) {
    const archivePath = path.join(ZIPS_DIR, entry.file);
    assert(
      fs.existsSync(archivePath),
      `missing negative fixture ${entry.file}`,
    );
    if (entry.extract === false) {
      const dest = makeTempDir(`negative-${entry.file}`);
      try {
        const result = extractArchive(sidecar, archivePath, dest, [], true);
        assert(
          result.code !== 0,
          `${entry.file} extract unexpectedly succeeded`,
        );
      } finally {
        fs.rmSync(dest, { recursive: true, force: true });
      }
    }
    console.log(`  negative ${entry.file}`);
  }
}

function testCreateRoundtrip(sidecar, manifest) {
  const work = makeTempDir("create");
  try {
    fs.writeFileSync(path.join(work, "hello.txt"), manifest.payloadText);
    for (const { format, extension, methodSwitches } of CREATE_MATRIX) {
      const archive = path.join(work, `created.${extension}`);
      run7z(
        sidecar,
        [
          "a",
          `-t${format}`,
          "-mx=5",
          ...methodSwitches,
          "-snl",
          "-snh",
          archive,
          "--",
          "hello.txt",
        ],
        { cwd: work },
      );
      const dest = path.join(work, `out-${format}`);
      extractArchive(sidecar, archive, dest);
      assertPayload(dest, "hello.txt", manifest.payloadText);
      console.log(`  create ${format}`);
    }
    assert(
      !CREATE_MATRIX.some((item) => item.format === "rar"),
      "create matrix must not include RAR",
    );
    assert(
      !CREATE_MATRIX.some((item) => item.extension.includes("tar.")),
      "create matrix must not include compound TAR",
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function testSplitVolume(sidecar) {
  const work = makeTempDir("split");
  try {
    const blob = path.join(work, "blob.bin");
    randomBytesFile(blob, 96 * 1024);
    const archive = path.join(work, "split.7z");
    run7z(sidecar, ["a", "-t7z", "-mx=0", "-v32k", archive, "--", blob], {
      cwd: work,
    });
    const firstVolume = path.join(work, "split.7z.001");
    assert(fs.existsSync(firstVolume), "expected split.7z.001");
    assert(
      fs.existsSync(path.join(work, "split.7z.002")),
      "expected split.7z.002",
    );
    const dest = path.join(work, "out");
    extractArchive(sidecar, firstVolume, dest);
    const extracted = findMemberFile(dest, "blob.bin");
    assert(extracted, "split extract missing blob.bin");
    assert(
      fs.readFileSync(extracted).equals(fs.readFileSync(blob)),
      "split extract payload mismatch",
    );
    console.log("  split volume");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function testUnixSymlinkZip(sidecar) {
  if (process.platform === "win32") {
    console.log("  skip unix symlink zip on win32");
    return;
  }
  const work = makeTempDir("symlink-zip");
  try {
    fs.mkdirSync(path.join(work, "tree", "real"), { recursive: true });
    fs.writeFileSync(
      path.join(work, "tree", "real", "file.txt"),
      "zip links\n",
    );
    fs.symlinkSync("real/file.txt", path.join(work, "tree", "current"));
    const archive = path.join(work, "links.zip");
    run7z(sidecar, ["a", "-tzip", "-snl", "-snh", archive, "--", "tree"], {
      cwd: work,
    });
    const dest = path.join(work, "out");
    extractArchive(sidecar, archive, dest, ["-snld10"]);
    const link = path.join(dest, "tree", "current");
    assert(
      fs.lstatSync(link).isSymbolicLink(),
      "extracted current is not a symlink",
    );
    assert(
      fs.readlinkSync(link) === "real/file.txt",
      `unexpected symlink target ${fs.readlinkSync(link)}`,
    );
    console.log("  unix symlink zip");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function main() {
  console.log(
    `test-archives: ${process.platform} ${process.arch} ${os.arch()}`,
  );
  const sidecar = requireHostSidecar();
  console.log(`sidecar: ${sidecar}`);
  const manifest = loadArchiveManifest();
  const payloadOnDisk = fs.readFileSync(
    path.join(ZIPS_DIR, manifest.payloadFile),
    "utf8",
  );
  assert(
    payloadOnDisk === manifest.payloadText,
    "hello.txt does not match manifest.payloadText",
  );

  testIntegrityAndExtract(sidecar, manifest);
  testNegatives(sidecar, manifest);
  testCreateRoundtrip(sidecar, manifest);
  testSplitVolume(sidecar);
  testUnixSymlinkZip(sidecar);
  console.log("test-archives: ok");
}

try {
  main();
} catch (error) {
  const message =
    error instanceof Error ? error.stack || error.message : String(error);
  console.error(`test-archives: FAIL ${message}`);
  process.exitCode = 1;
}
