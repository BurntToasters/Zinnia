"use strict";

function assertReleaseTagName(release, expectedTag, context = "Draft release") {
  if (release?.tag_name === expectedTag) return release;
  throw new Error(
    `${context} ${release?.id ?? "with unknown id"} has tag_name ` +
      `${JSON.stringify(release?.tag_name ?? null)}, expected ${JSON.stringify(expectedTag)}. ` +
      "Retag the existing draft before continuing; do not create another draft.",
  );
}

function assertNoMisnamedVersionDrafts(
  releases,
  expectedTag,
  expectedName = String(expectedTag || "").replace(/^v/, ""),
) {
  const misnamed = (Array.isArray(releases) ? releases : []).filter(
    (release) =>
      release?.draft &&
      release.name === expectedName &&
      release.tag_name !== expectedTag,
  );
  if (misnamed.length === 0) return releases;

  const details = misnamed
    .map(
      (release) =>
        `id ${release.id ?? "unknown"}: ${JSON.stringify(release.tag_name ?? null)}`,
    )
    .join(", ");
  throw new Error(
    `Found draft named ${JSON.stringify(expectedName)} with wrong tag_name (${details}); ` +
      `expected ${JSON.stringify(expectedTag)}. Retag the existing draft before continuing; ` +
      "do not create another draft.",
  );
}

module.exports = {
  assertNoMisnamedVersionDrafts,
  assertReleaseTagName,
};
