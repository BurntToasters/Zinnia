/** Compile-time unpackaged E2E flag. Empty in production Vite builds. */
export function isE2eFrontend(): boolean {
  return import.meta.env.VITE_ZINNIA_E2E === "1";
}
