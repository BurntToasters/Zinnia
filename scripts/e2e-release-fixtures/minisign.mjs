// Minimal minisign (prehashed "ED" + Ed25519) helpers for the release dry run.
// Keys are generated at runtime; nothing here is a real signing key.
// The same module backs the cargo stand-in that replaces the Rust verifier
// (src-tauri/examples/verify_updater_signatures.rs) because cargo builds are
// not part of this dry run.

import crypto from "node:crypto";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function generateMinisignKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return {
    privateKey,
    publicKey,
    publicRaw: spki.subarray(spki.length - 32),
    keyId: crypto.randomBytes(8),
  };
}

export function minisignPublicKeyText(key) {
  const packet = Buffer.concat([Buffer.from("Ed"), key.keyId, key.publicRaw]);
  return (
    `untrusted comment: minisign public key ${key.keyId.toString("hex").toUpperCase()}\n` +
    `${packet.toString("base64")}\n`
  );
}

// Tauri stores the public key file text base64-encoded in tauri.conf.json.
export function tauriPubkeyFromText(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

export function signBytes(bytes, key, trustedComment) {
  const digest = crypto.createHash("blake2b512").update(bytes).digest();
  const signature = crypto.sign(null, digest, key.privateKey);
  const packet = Buffer.concat([Buffer.from("ED"), key.keyId, signature]);
  const globalSignature = crypto.sign(
    null,
    Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]),
    key.privateKey,
  );
  return (
    "untrusted comment: signature from minisign secret key\n" +
    `${packet.toString("base64")}\n` +
    `trusted comment: ${trustedComment}\n` +
    `${globalSignature.toString("base64")}\n`
  );
}

// Tauri .sig files hold the base64 of the minisign signature text.
export function tauriSignatureFileContent(signatureText) {
  return Buffer.from(signatureText, "utf8").toString("base64");
}

function parsePublicKeyText(text) {
  const lines = String(text).trim().split(/\r?\n/);
  if (lines.length < 2 || !lines[0].startsWith("untrusted comment:")) {
    throw new Error("public key is not a minisign public key file");
  }
  const packet = Buffer.from(lines[1], "base64");
  if (packet.length !== 42 || packet.subarray(0, 2).toString() !== "Ed") {
    throw new Error("public key packet is malformed");
  }
  return {
    keyId: packet.subarray(2, 10),
    publicKey: crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, packet.subarray(10, 42)]),
      format: "der",
      type: "spki",
    }),
  };
}

// Throws unless signatureText is a valid prehashed minisign signature over
// bytes by the key in publicKeyText.
export function verifyMinisignBytes(bytes, signatureText, publicKeyText) {
  const { keyId, publicKey } = parsePublicKeyText(publicKeyText);
  const lines = String(signatureText).trim().split(/\r?\n/);
  if (
    lines.length !== 4 ||
    !lines[0].startsWith("untrusted comment:") ||
    !lines[2].startsWith("trusted comment: ")
  ) {
    throw new Error("signature is not a four-line minisign envelope");
  }
  const packet = Buffer.from(lines[1], "base64");
  if (
    packet.length !== 74 ||
    packet.subarray(0, 2).toString() !== "ED" ||
    !packet.subarray(2, 10).equals(keyId)
  ) {
    throw new Error("signature packet is malformed or from another key");
  }
  const signature = packet.subarray(10, 74);
  const digest = crypto.createHash("blake2b512").update(bytes).digest();
  if (!crypto.verify(null, digest, publicKey, signature)) {
    throw new Error("prehashed signature does not match artifact bytes");
  }
  const trustedComment = Buffer.from(
    lines[2].slice("trusted comment: ".length),
    "utf8",
  );
  const globalSignature = Buffer.from(lines[3], "base64");
  if (
    !crypto.verify(
      null,
      Buffer.concat([signature, trustedComment]),
      publicKey,
      globalSignature,
    )
  ) {
    throw new Error("global signature over the trusted comment is invalid");
  }
  return true;
}
