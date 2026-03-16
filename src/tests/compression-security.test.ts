import assert from "node:assert/strict";

import {
  getCompressionSecuritySupport,
  normalizeCompressionSecurityOptions,
  validateCompressionSecurityOptions,
} from "../compression-security.ts";

export function runCompressionSecurityTests() {
  assert.deepEqual(getCompressionSecuritySupport("7z"), { password: true, encryptHeaders: true });
  assert.deepEqual(getCompressionSecuritySupport("zip"), { password: true, encryptHeaders: false });
  assert.deepEqual(getCompressionSecuritySupport("tar"), { password: false, encryptHeaders: false });
  assert.deepEqual(getCompressionSecuritySupport("unknown-format"), { password: false, encryptHeaders: false });

  assert.deepEqual(
    normalizeCompressionSecurityOptions("7z", "  secret  ", true),
    { password: "secret", encryptHeaders: true }
  );
  assert.deepEqual(
    normalizeCompressionSecurityOptions("zip", "zip-pass", true),
    { password: "zip-pass", encryptHeaders: false }
  );
  assert.deepEqual(
    normalizeCompressionSecurityOptions("tar", "should-drop", true),
    { password: "", encryptHeaders: false }
  );

  assert.equal(validateCompressionSecurityOptions("7z", "", true), "Enter a password to enable file-name encryption.");
  assert.equal(validateCompressionSecurityOptions("7z", "secret", true), null);
  assert.equal(validateCompressionSecurityOptions("zip", "", true), null);
}
