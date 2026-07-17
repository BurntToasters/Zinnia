import { main } from "./post-release-assets.js";

// This dedicated entry point deliberately avoids relying on argv/path identity.
console.log("Finalizing release assets...");
main();
