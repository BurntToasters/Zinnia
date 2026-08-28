import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  APP_CREATE_PREFIX,
  APP_EXTRACT_SWITCHES,
  APP_LIST_SWITCHES,
  APP_TEST_SWITCHES,
  APP_UPDATE_SWITCHES,
  CREATE_MATRIX,
  UPDATE_FORMATS,
  ZIPS_DIR,
  findMemberFile,
  listingHasMember,
  loadArchiveManifest,
  makeTempDir,
  parseSltMemberPaths,
  passwordArgs,
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
    [
      "x",
      `-o${dest}`,
      ...APP_EXTRACT_SWITCHES,
      ...extraArgs,
      "--",
      archivePath,
    ],
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

function copyFixture(fileName, destDir) {
  const dest = path.join(destDir, fileName);
  fs.copyFileSync(path.join(ZIPS_DIR, fileName), dest);
  return dest;
}

function listArchive(
  sidecar,
  archivePath,
  extraArgs = [],
  allowFailure = false,
) {
  return run7z(
    sidecar,
    [...APP_LIST_SWITCHES, ...extraArgs, "--", archivePath],
    {
      allowFailure,
    },
  );
}

function testIntegrity(
  sidecar,
  archivePath,
  extraArgs = [],
  allowFailure = false,
) {
  return run7z(
    sidecar,
    [...APP_TEST_SWITCHES, ...extraArgs, "--", archivePath],
    {
      allowFailure,
    },
  );
}

function listingMembersFor(entry) {
  // bzip2/xz streams have no stored member name in `l -slt` (including .tbz2/.txz).
  if (entry.family === "bzip2" || entry.family === "xz") return [];
  if (entry.compoundTar) return ["hello.tar"];
  return entry.members;
}

function testIntegrityListExtract(sidecar, manifest) {
  const password = manifest.password;
  for (const entry of manifest.extract) {
    const archivePath = path.join(ZIPS_DIR, entry.file);
    assert(fs.existsSync(archivePath), `missing fixture ${entry.file}`);
    const extra = entry.password ? passwordArgs(password) : [];
    testIntegrity(sidecar, archivePath, extra);

    const listed = listArchive(sidecar, archivePath, extra);
    for (const member of listingMembersFor(entry)) {
      assert(
        listingHasMember(listed.stdout, member),
        `${entry.file} listing missing ${member}`,
      );
    }

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
    console.log(`  extract/list/test ${entry.file}`);
  }
}

function testEncryptedDeniedWithoutPassword(sidecar, manifest) {
  const password = manifest.password;
  for (const entry of manifest.extract.filter((item) => item.password)) {
    const archivePath = path.join(ZIPS_DIR, entry.file);
    const wrong = testIntegrity(
      sidecar,
      archivePath,
      passwordArgs("wrong-password"),
      true,
    );
    assert(
      wrong.code !== 0,
      `${entry.file} integrity test succeeded with the wrong password`,
    );

    const missingTest = testIntegrity(sidecar, archivePath, [], true);
    assert(
      missingTest.code !== 0,
      `${entry.file} integrity test succeeded without a password`,
    );

    const dest = makeTempDir(`denied-${entry.file.replaceAll(".", "-")}`);
    try {
      const missingExtract = extractArchive(
        sidecar,
        archivePath,
        dest,
        [],
        true,
      );
      assert(
        missingExtract.code !== 0,
        `${entry.file} extract succeeded without a password`,
      );
      const wrongExtract = extractArchive(
        sidecar,
        archivePath,
        dest,
        passwordArgs("wrong-password"),
        true,
      );
      assert(
        wrongExtract.code !== 0,
        `${entry.file} extract succeeded with the wrong password`,
      );
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }

    // Header-encrypted 7z hides names; AES ZIP may still list them.
    if (entry.family === "7z") {
      const missingList = listArchive(sidecar, archivePath, [], true);
      assert(
        missingList.code !== 0,
        `${entry.file} listing succeeded without a password`,
      );
    }
    const listed = listArchive(sidecar, archivePath, passwordArgs(password));
    for (const member of entry.members) {
      assert(
        listingHasMember(listed.stdout, member),
        `${entry.file} password listing missing ${member}`,
      );
    }
    console.log(`  denied-without-password ${entry.file}`);
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
          ...APP_CREATE_PREFIX,
          `-t${format}`,
          "-mx=5",
          ...methodSwitches,
          archive,
          "--",
          "hello.txt",
        ],
        { cwd: work },
      );
      const listed = listArchive(sidecar, archive);
      const listedMembers = parseSltMemberPaths(listed.stdout);
      if (listedMembers.length > 0) {
        assert(
          listingHasMember(listed.stdout, "hello.txt"),
          `created ${format} listing missing hello.txt`,
        );
      }
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

function testAddToExisting(sidecar, manifest) {
  const work = makeTempDir("update");
  try {
    fs.writeFileSync(path.join(work, "extra.txt"), "zinnia extra member\n");
    for (const format of UPDATE_FORMATS) {
      const archive = copyFixture(`hello.${format}`, work);
      run7z(sidecar, [...APP_UPDATE_SWITCHES, archive, "--", "extra.txt"], {
        cwd: work,
      });
      const dest = path.join(work, `out-${format}`);
      extractArchive(sidecar, archive, dest);
      assertPayload(dest, "hello.txt", manifest.payloadText);
      assertPayload(dest, "extra.txt", "zinnia extra member\n");
      console.log(`  add-to-existing ${format}`);
    }

    const encryptedZip = copyFixture("encrypted-aes.zip", work);
    run7z(
      sidecar,
      [
        ...APP_UPDATE_SWITCHES,
        ...passwordArgs(manifest.password),
        "-mem=AES256",
        encryptedZip,
        "--",
        "extra.txt",
      ],
      { cwd: work },
    );
    const encryptedDest = path.join(work, "out-encrypted-zip");
    extractArchive(
      sidecar,
      encryptedZip,
      encryptedDest,
      passwordArgs(manifest.password),
    );
    assertPayload(encryptedDest, "hello.txt", manifest.payloadText);
    assertPayload(encryptedDest, "extra.txt", "zinnia extra member\n");
    console.log("  add-to-existing encrypted-aes.zip");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function testSelectiveExtract(sidecar, manifest) {
  const work = makeTempDir("selective");
  try {
    fs.writeFileSync(path.join(work, "keep.txt"), manifest.payloadText);
    fs.writeFileSync(path.join(work, "skip.txt"), "should not extract\n");
    const archive = path.join(work, "pair.zip");
    run7z(
      sidecar,
      [
        "a",
        ...APP_CREATE_PREFIX,
        "-tzip",
        "-mx=5",
        "-m0=deflate",
        archive,
        "--",
        "keep.txt",
        "skip.txt",
      ],
      { cwd: work },
    );
    const dest = path.join(work, "out");
    fs.mkdirSync(dest, { recursive: true });
    run7z(sidecar, [
      "x",
      `-o${dest}`,
      ...APP_EXTRACT_SWITCHES,
      "--",
      archive,
      "keep.txt",
    ]);
    assertPayload(dest, "keep.txt", manifest.payloadText);
    assert(
      !fs.existsSync(path.join(dest, "skip.txt")),
      "selective extract leaked skip.txt",
    );

    const nested = path.join(ZIPS_DIR, "nested.zip");
    const nestedDest = path.join(work, "nested-out");
    fs.mkdirSync(nestedDest, { recursive: true });
    run7z(sidecar, [
      "x",
      `-o${nestedDest}`,
      ...APP_EXTRACT_SWITCHES,
      "--",
      nested,
      "nested/hello.txt",
    ]);
    assertPayload(nestedDest, "nested/hello.txt", manifest.payloadText);
    console.log("  selective extract");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function testConvertRoundtrip(sidecar, manifest) {
  const work = makeTempDir("convert");
  try {
    const source = copyFixture("hello.zip", work);
    const extracted = path.join(work, "extracted");
    extractArchive(sidecar, source, extracted);
    const children = fs
      .readdirSync(extracted)
      .map((name) => path.join(extracted, name));
    assert(children.length > 0, "convert extract produced no children");
    const converted = path.join(work, "converted.7z");
    const sevenZ = CREATE_MATRIX.find((item) => item.format === "7z");
    run7z(sidecar, [
      "a",
      ...APP_CREATE_PREFIX,
      "-t7z",
      "-mx=5",
      ...sevenZ.methodSwitches,
      converted,
      "--",
      ...children,
    ]);
    const dest = path.join(work, "out");
    extractArchive(sidecar, converted, dest);
    assertPayload(dest, "hello.txt", manifest.payloadText);
    console.log("  convert zip -> 7z");
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
    const extra = path.join(work, "extra.txt");
    fs.writeFileSync(extra, "nope\n");
    const update = run7z(
      sidecar,
      [...APP_UPDATE_SWITCHES, "-v32k", firstVolume, "--", extra],
      { cwd: work, allowFailure: true },
    );
    assert(
      update.code !== 0,
      "split-volume update with -v unexpectedly succeeded",
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
    run7z(
      sidecar,
      ["a", "-tzip", ...APP_CREATE_PREFIX, archive, "--", "tree"],
      { cwd: work },
    );
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

  testIntegrityListExtract(sidecar, manifest);
  testEncryptedDeniedWithoutPassword(sidecar, manifest);
  testNegatives(sidecar, manifest);
  testCreateRoundtrip(sidecar, manifest);
  testAddToExisting(sidecar, manifest);
  testSelectiveExtract(sidecar, manifest);
  testConvertRoundtrip(sidecar, manifest);
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
