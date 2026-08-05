/** Inject or replace the 7-Zip password switch before the `--` separator. */
export function withPassword(args: string[], password: string): string[] {
  const separator = args.indexOf("--");
  const head = separator === -1 ? args.slice() : args.slice(0, separator);
  const tail = separator === -1 ? [] : args.slice(separator);
  return [
    ...head.filter((argument) => argument.slice(0, 2).toLowerCase() !== "-p"),
    `-p${password}`,
    ...tail,
  ];
}
