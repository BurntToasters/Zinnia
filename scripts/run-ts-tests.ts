import { runArchiveRulesTests } from "../src/tests/archive-rules.test.ts";
import { runCompressionSecurityTests } from "../src/tests/compression-security.test.ts";
import { runExtractPathTests } from "../src/tests/extract-path.test.ts";
import { runOutputLoggingTests } from "../src/tests/output-logging.test.ts";
import { runSelectiveExtractTests } from "../src/tests/selective-extract.test.ts";
import { runSettingsModelTests } from "../src/tests/settings-model.test.ts";
import { runUtilsTests } from "../src/tests/utils.test.ts";

type Suite = {
  name: string;
  run: () => void | Promise<void>;
};

const suites: Suite[] = [
  { name: "archive-rules", run: runArchiveRulesTests },
  { name: "compression-security", run: runCompressionSecurityTests },
  { name: "extract-path", run: runExtractPathTests },
  { name: "output-logging", run: runOutputLoggingTests },
  { name: "selective-extract", run: runSelectiveExtractTests },
  { name: "settings-model", run: runSettingsModelTests },
  { name: "utils", run: runUtilsTests },
];

let failed = 0;

for (const suite of suites) {
  try {
    await suite.run();
    console.log(`PASS ${suite.name}`);
  } catch (err) {
    failed += 1;
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`FAIL ${suite.name}\n${msg}`);
  }
}

if (failed > 0) {
  process.exit(1);
}

console.log(`All TS test suites passed (${suites.length}).`);
