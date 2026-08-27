import fs from "node:fs";
import path from "node:path";
import {
  CREATE_MATRIX,
  ZIPS_DIR,
  buildStoredRar4,
  loadArchiveManifest,
  makeTempDir,
  requireHostSidecar,
  run7z,
} from "./archive-fixtures.js";

const writeRar = process.argv.includes("--write-rar");

function copyIfExists(from, to) {
  fs.copyFileSync(from, to);
}

function generate() {
  const sidecar = requireHostSidecar();
  const manifest = loadArchiveManifest();
  const payloadText = fs.readFileSync(
    path.join(ZIPS_DIR, manifest.payloadFile),
    "utf8",
  );
  if (payloadText !== manifest.payloadText) {
    throw new Error(
      `zips/${manifest.payloadFile} does not match manifest.payloadText`,
    );
  }

  const work = makeTempDir("generate-archives");
  try {
    const payloadPath = path.join(work, "hello.txt");
    fs.writeFileSync(payloadPath, payloadText);

    for (const { format, extension, methodSwitches } of CREATE_MATRIX) {
      const archive = path.join(work, `hello.${extension}`);
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
      copyIfExists(archive, path.join(ZIPS_DIR, `hello.${extension}`));
    }

    const innerTar = path.join(work, "hello.tar");
    const compound = [
      { format: "gzip", out: "hello.tar.gz", alias: "hello.tgz" },
      { format: "bzip2", out: "hello.tar.bz2", alias: "hello.tbz2" },
      { format: "xz", out: "hello.tar.xz", alias: "hello.txz" },
    ];
    for (const { format, out, alias } of compound) {
      const archive = path.join(work, out);
      run7z(sidecar, ["a", `-t${format}`, archive, "--", innerTar], {
        cwd: work,
      });
      copyIfExists(archive, path.join(ZIPS_DIR, out));
      copyIfExists(archive, path.join(ZIPS_DIR, alias));
    }

    const nestedDir = path.join(work, "nested");
    fs.mkdirSync(nestedDir);
    fs.writeFileSync(path.join(nestedDir, "hello.txt"), payloadText);
    const nestedZip = path.join(work, "nested.zip");
    run7z(
      sidecar,
      ["a", "-tzip", "-mx=5", "-m0=deflate", nestedZip, "--", "nested"],
      { cwd: work },
    );
    copyIfExists(nestedZip, path.join(ZIPS_DIR, "nested.zip"));

    const unicodeName = "héllo.txt";
    fs.writeFileSync(path.join(work, unicodeName), payloadText);
    const unicodeZip = path.join(work, "unicode.zip");
    run7z(
      sidecar,
      ["a", "-tzip", "-mx=5", "-m0=deflate", unicodeZip, "--", unicodeName],
      { cwd: work },
    );
    copyIfExists(unicodeZip, path.join(ZIPS_DIR, "unicode.zip"));

    const encrypted7z = path.join(work, "encrypted.7z");
    run7z(
      sidecar,
      [
        "a",
        "-t7z",
        "-mx=5",
        "-mhe=on",
        `-p${manifest.password}`,
        encrypted7z,
        "--",
        "hello.txt",
      ],
      { cwd: work },
    );
    copyIfExists(encrypted7z, path.join(ZIPS_DIR, "encrypted.7z"));

    const encryptedZip = path.join(work, "encrypted-aes.zip");
    run7z(
      sidecar,
      [
        "a",
        "-tzip",
        "-mx=5",
        "-mem=AES256",
        `-p${manifest.password}`,
        encryptedZip,
        "--",
        "hello.txt",
      ],
      { cwd: work },
    );
    copyIfExists(encryptedZip, path.join(ZIPS_DIR, "encrypted-aes.zip"));

    fs.writeFileSync(
      path.join(ZIPS_DIR, "not-an-archive.bin"),
      "this is not an archive\n",
    );
    fs.writeFileSync(
      path.join(ZIPS_DIR, "truncated.zip"),
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]),
    );

    const rarPath = path.join(ZIPS_DIR, "hello.rar");
    if (writeRar || !fs.existsSync(rarPath)) {
      if (!writeRar && !fs.existsSync(rarPath)) {
        throw new Error(
          "zips/hello.rar is missing. Re-run with --write-rar to create the stored RAR4 sample.",
        );
      }
      fs.writeFileSync(rarPath, buildStoredRar4("hello.txt", payloadText));
    }

    console.log(`generate-test-archives: wrote fixtures into ${ZIPS_DIR}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

generate();
