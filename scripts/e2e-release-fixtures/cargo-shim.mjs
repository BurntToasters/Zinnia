// Stand-in for `cargo run ... --example verify_updater_signatures -- <pubkey> <artifact> <sig>...`.
// The release dry run must not run cargo builds, so this verifies the same
// minisign pairs in Node (see minisign.mjs). Any other cargo invocation is
// refused. Each call is appended to FAKE_CARGO_LOG as one JSON line.

import fs from "node:fs";
import path from "node:path";
import { verifyMinisignBytes } from "./minisign.mjs";

const args = process.argv.slice(2);
const separator = args.indexOf("--");
const isVerifierCall =
  args.includes("verify_updater_signatures") && separator !== -1;
if (!isVerifierCall) {
  process.stderr.write(
    `cargo stand-in refuses: ${args.join(" ")} (release dry run runs no cargo builds)\n`,
  );
  process.exit(2);
}

const [publicKeyPath, ...pairs] = args.slice(separator + 1);
if (!publicKeyPath || pairs.length === 0 || pairs.length % 2 !== 0) {
  process.stderr.write(
    "usage: verify_updater_signatures <pubkey> <artifact> <sig> [...]\n",
  );
  process.exit(2);
}

const publicKeyText = fs.readFileSync(publicKeyPath, "utf8");
const results = [];
let failed = false;
for (let i = 0; i < pairs.length; i += 2) {
  const artifact = pairs[i];
  const record = { artifact: path.basename(artifact), ok: true };
  try {
    verifyMinisignBytes(
      fs.readFileSync(artifact),
      fs.readFileSync(pairs[i + 1], "utf8"),
      publicKeyText,
    );
    process.stdout.write(`verified updater signature: ${artifact}\n`);
  } catch (error) {
    record.ok = false;
    record.error = error instanceof Error ? error.message : String(error);
    failed = true;
    process.stderr.write(
      `updater signature does not match ${artifact}: ${record.error}\n`,
    );
  }
  results.push(record);
}

if (process.env.FAKE_CARGO_LOG) {
  fs.appendFileSync(
    process.env.FAKE_CARGO_LOG,
    `${JSON.stringify({ pairs: pairs.length / 2, results })}\n`,
  );
}
process.exit(failed ? 1 : 0);
