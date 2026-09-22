import { invoke } from "@tauri-apps/api/core";
import { dom, state } from "./state";
import { ensureArchivePaths } from "./archive-rules";
import { buildArgs, buildExtractArgsFor } from "./archive/args";
import { buildSelectiveExtractArgs } from "./selective-extract";
import {
  ensureRuntimeReady,
  invokeGuardedRun7z,
  type Run7zResult,
} from "./archive/runtime";
import { confirmExtractDestination } from "./extract-destination";

export const ARCHIVE_BENCHMARK_OPERATIONS = [
  "browse",
  "test",
  "extract",
  "create",
  "replace",
  "update",
  "selective-extract",
  "conversion",
  "batch",
] as const;

export type ArchiveBenchmarkOperation =
  (typeof ARCHIVE_BENCHMARK_OPERATIONS)[number];

export interface ArchiveBenchmarkRequest {
  operation: ArchiveBenchmarkOperation;
  archive: string;
  source: string;
  output: string;
  target: string;
  selection?: string;
  format: string;
  targetFormat?: string;
  workload: string;
  password?: string;
}

export interface ArchiveBenchmarkResult {
  durationMs: number;
  code: number;
  stdout?: string;
}

// Keep the WebDriver result bounded while allowing a complete listing from
// the backend's 10 MiB-bounded run_7z output envelope. The release fixture's
// 2,048-entry ZIP listing is over 512 KiB, so the old result cap could turn a
// valid listing into a false missing-path verification failure.
export const MAX_RESULT_STDOUT_CHARS = 10 * 1024 * 1024;

type FormElement = HTMLInputElement | HTMLSelectElement;

type FormSnapshot = {
  mode: string;
  inputs: string[];
  values: Map<string, string>;
  checked: Map<string, boolean>;
};

const FORM_VALUE_IDS = [
  "output-path",
  "extract-path",
  "extract-password",
  "extract-extra-args",
  "browse-password",
  "format",
  "level",
  "method",
  "dict",
  "word-size",
  "solid",
  "threads",
  "split-size",
  "split-custom",
  "password",
  "extra-args",
] as const;

const FORM_CHECKED_IDS = [
  "update-mode",
  "encrypt-headers",
  "delete-after",
  "store-timestamps",
] as const;

function requiredElement(id: string): FormElement {
  const element = document.getElementById(id) as FormElement | null;
  if (!element) throw new Error(`E2E benchmark form field is missing: ${id}`);
  return element;
}

function setValue(id: string, value: string): void {
  requiredElement(id).value = value;
}

function setChecked(id: string, value: boolean): void {
  const element = requiredElement(id);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`E2E benchmark field is not a checkbox: ${id}`);
  }
  element.checked = value;
}

function snapshotForm(): FormSnapshot {
  const values = new Map<string, string>();
  const checked = new Map<string, boolean>();
  for (const id of FORM_VALUE_IDS) values.set(id, requiredElement(id).value);
  for (const id of FORM_CHECKED_IDS) {
    const element = requiredElement(id);
    if (!(element instanceof HTMLInputElement)) {
      throw new Error(`E2E benchmark field is not a checkbox: ${id}`);
    }
    checked.set(id, element.checked);
  }
  return {
    mode: dom.appEl.dataset.mode ?? "add",
    inputs: [...state.inputs],
    values,
    checked,
  };
}

function restoreForm(snapshot: FormSnapshot): void {
  dom.appEl.dataset.mode = snapshot.mode;
  state.inputs = snapshot.inputs;
  for (const [id, value] of snapshot.values) setValue(id, value);
  for (const [id, value] of snapshot.checked) setChecked(id, value);
}

function withForm<T>(
  mode: "add" | "extract" | "browse",
  inputs: string[],
  configure: () => void,
  build: () => T,
): T {
  const snapshot = snapshotForm();
  try {
    // buildArgs reads these values through the production DOM-backed seam. Do
    // not call setMode/renderInputs here: those functions start background
    // archive probes, while this runner needs one deterministic operation.
    dom.appEl.dataset.mode = mode;
    state.inputs = [...inputs];
    configure();
    return build();
  } finally {
    restoreForm(snapshot);
  }
}

function normalizeFormat(value: string, label: string): string {
  const format = value.trim().toLowerCase();
  if (!/^[a-z0-9]+$/.test(format)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return format;
}

function requireRequestString(
  request: ArchiveBenchmarkRequest,
  key: keyof ArchiveBenchmarkRequest,
): string {
  const value = request[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Archive benchmark request requires ${String(key)}.`);
  }
  return value;
}

function validateRequest(
  request: ArchiveBenchmarkRequest,
): asserts request is ArchiveBenchmarkRequest {
  if (!request || typeof request !== "object") {
    throw new Error("Archive benchmark request must be an object.");
  }
  if (
    !ARCHIVE_BENCHMARK_OPERATIONS.includes(
      request.operation as ArchiveBenchmarkOperation,
    )
  ) {
    throw new Error(
      `Unsupported archive benchmark operation: ${request.operation}`,
    );
  }
  for (const key of [
    "archive",
    "source",
    "output",
    "target",
    "format",
    "workload",
  ] as const) {
    requireRequestString(request, key);
  }
  if (
    request.targetFormat !== undefined &&
    typeof request.targetFormat !== "string"
  ) {
    throw new Error("Archive benchmark targetFormat must be a string.");
  }
  if (request.password !== undefined && typeof request.password !== "string") {
    throw new Error("Archive benchmark password must be a string.");
  }
  if (
    request.selection !== undefined &&
    typeof request.selection !== "string"
  ) {
    throw new Error("Archive benchmark selection must be a string.");
  }
}

function selectionPaths(selection: string | undefined): string[] {
  if (!selection) return [];
  const trimmed = selection.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      Array.isArray(parsed) &&
      parsed.every((entry) => typeof entry === "string")
    ) {
      return parsed.filter((entry) => entry.length > 0);
    }
  } catch {
    // A single member path is the normal benchmark contract.
  }
  return trimmed.split("\n").filter(Boolean);
}

function configureSafeCompressionForm(
  request: ArchiveBenchmarkRequest,
  targetPath: string,
  updateMode: boolean,
  format = request.format,
): void {
  const normalizedFormat = normalizeFormat(format, "format");
  setValue("format", normalizedFormat);
  setValue("output-path", targetPath);
  setValue("level", "5");
  setValue(
    "method",
    normalizedFormat === "zip"
      ? "deflate"
      : normalizedFormat === "7z"
        ? "lzma2"
        : "",
  );
  setValue("dict", "256m");
  setValue("word-size", "64");
  setValue("solid", "16g");
  setValue("split-size", "");
  setValue("split-custom", "");
  setValue("password", request.password ?? "");
  setValue("extra-args", "");
  setChecked("update-mode", updateMode);
  setChecked("encrypt-headers", false);
  setChecked("delete-after", false);
  setChecked("store-timestamps", false);
}

function configureSafeExtractForm(
  request: ArchiveBenchmarkRequest,
  destination: string,
): void {
  setValue("extract-path", destination);
  setValue("extract-password", request.password ?? "");
  setValue("extract-extra-args", "");
}

function compressionInputs(request: ArchiveBenchmarkRequest): string[] {
  // Direct benchmark commands run from fixture.root and pass payload/bulk.bin,
  // so archive members include the `payload/` component. The product receives
  // absolute paths; pass the bulk parent directory to preserve same member
  // shape without changing production path handling for normal users.
  if (request.workload.toLowerCase() !== "bulk") return [request.source];
  const separator = request.source.includes("\\") ? "\\" : "/";
  const index = request.source.lastIndexOf(separator);
  return index > 0 ? [request.source.slice(0, index)] : [request.source];
}

async function validatedArchive(
  archive: string,
  operation: "browse" | "extract" | "test",
): Promise<string> {
  const [validation] = await ensureArchivePaths(
    [archive],
    operation,
    undefined,
    true,
  );
  if (!validation?.valid || !validation.identity) {
    throw new Error("Could not capture a stable archive identity.");
  }
  return validation.identity;
}

/**
 * The backend uses the literal `absent` token to prove that a create/update
 * destination was missing when it was selected. Do not turn that sentinel
 * into undefined: undefined omits the IPC envelope and permits a stale output
 * to be treated as a valid create target.
 */
export function validateArchiveOutputSelectionToken(token: unknown): string {
  if (
    typeof token !== "string" ||
    (token !== "absent" && !/^[a-f0-9]{64}$/.test(token))
  ) {
    throw new Error(
      "Archive output selection token must be the literal absent sentinel or a 64-character hex family token.",
    );
  }
  return token;
}

async function outputSelectionToken(path: string): Promise<string> {
  const token = await invoke<string>("archive_output_selection_token", {
    path,
  });
  return validateArchiveOutputSelectionToken(token);
}

function effectiveCode(result: Run7zResult): number {
  return result.warning_code && result.warning_code !== 0
    ? result.warning_code
    : result.code;
}

function appendOutput(outputs: string[], result: Run7zResult): void {
  if (result.stdout) outputs.push(result.stdout);
}

export function collectArchiveBenchmarkStdout(
  outputs: readonly string[],
): string | undefined {
  if (outputs.length === 0) return undefined;
  const value = outputs.join("\n");
  if (value.length <= MAX_RESULT_STDOUT_CHARS) return value;
  throw new Error(
    `Archive benchmark stdout exceeded the ${MAX_RESULT_STDOUT_CHARS / (1024 * 1024)} MiB E2E result limit; refusing to return a partial result.`,
  );
}

export function assertArchiveBenchmarkOutputComplete(
  run: Pick<Run7zResult, "stdout_truncated" | "stderr_truncated">,
  operation: string,
): void {
  const truncatedStreams: string[] = [];
  if (run.stdout_truncated) truncatedStreams.push("stdout");
  if (run.stderr_truncated) truncatedStreams.push("stderr");
  if (truncatedStreams.length > 0) {
    throw new Error(
      `Archive benchmark ${operation} output was truncated by the backend (${truncatedStreams.join(" and ")}); refusing to verify a partial result.`,
    );
  }
}

function result(
  startedAt: number,
  code: number,
  outputs: string[],
): ArchiveBenchmarkResult {
  const stdout = collectArchiveBenchmarkStdout(outputs);
  return {
    durationMs: Math.max(0, performance.now() - startedAt),
    code,
    ...(stdout ? { stdout } : {}),
  };
}

async function run7z(
  args: string[],
  expectedArchiveIdentity: string | undefined,
  outputs: string[],
): Promise<Run7zResult> {
  const run = await invokeGuardedRun7z(args, expectedArchiveIdentity);
  appendOutput(outputs, run);
  return run;
}

function assertFinalIdentity(
  run: Run7zResult,
  expected: string,
  operation: string,
): void {
  if (!run.archiveIdentityAfter) {
    throw new Error(
      `Archive identity was not returned after ${operation}. Operation was not accepted.`,
    );
  }
  if (run.archiveIdentityAfter !== expected) {
    throw new Error(
      `Archive changed while ${operation} was running. Operation was not accepted.`,
    );
  }
}

async function extractArgs(
  request: ArchiveBenchmarkRequest,
  archive: string,
  destination: string,
  selectedPaths: string[] = [],
): Promise<string[]> {
  return withForm(
    "extract",
    [archive],
    () => configureSafeExtractForm(request, destination),
    () =>
      selectedPaths.length > 0
        ? buildSelectiveExtractArgs(
            archive,
            destination,
            request.password ?? "",
            [],
            selectedPaths,
          )
        : buildExtractArgsFor(archive),
  );
}

async function runArchiveOperation(
  request: ArchiveBenchmarkRequest,
  startedAt: number,
  outputs: string[],
): Promise<ArchiveBenchmarkResult> {
  const format = normalizeFormat(request.format, "format");
  switch (request.operation) {
    case "browse": {
      const identity = await validatedArchive(request.archive, "browse");
      const args = ["l", "-slt", "-spd"];
      if (request.password) args.push(`-p${request.password}`);
      args.push("--", request.archive);
      const run = await run7z(args, identity, outputs);
      assertArchiveBenchmarkOutputComplete(run, "browse");
      if (effectiveCode(run) === 0)
        assertFinalIdentity(run, identity, "browse");
      return result(startedAt, effectiveCode(run), outputs);
    }
    case "test": {
      const identity = await validatedArchive(request.archive, "test");
      const args = ["t", "-spd"];
      if (request.password) args.push(`-p${request.password}`);
      args.push("--", request.archive);
      const run = await run7z(args, identity, outputs);
      if (effectiveCode(run) === 0) assertFinalIdentity(run, identity, "test");
      return result(startedAt, effectiveCode(run), outputs);
    }
    case "extract": {
      const identity = await validatedArchive(request.archive, "extract");
      if (!(await confirmExtractDestination(request.output))) {
        return result(startedAt, -1, outputs);
      }
      const args = await extractArgs(request, request.archive, request.output);
      const run = await run7z(args, identity, outputs);
      return result(startedAt, effectiveCode(run), outputs);
    }
    case "selective-extract": {
      const identity = await validatedArchive(request.archive, "extract");
      if (!(await confirmExtractDestination(request.output))) {
        return result(startedAt, -1, outputs);
      }
      const args = await extractArgs(
        request,
        request.archive,
        request.output,
        selectionPaths(request.selection),
      );
      const run = await run7z(args, identity, outputs);
      return result(startedAt, effectiveCode(run), outputs);
    }
    case "create":
    case "replace":
    case "update": {
      const updateMode = request.operation === "update";
      const args = withForm(
        "add",
        compressionInputs(request),
        () =>
          configureSafeCompressionForm(
            request,
            request.target,
            updateMode,
            format,
          ),
        () => buildArgs(),
      );
      const expectedIdentity = await outputSelectionToken(request.target);
      const run = await run7z(args, expectedIdentity, outputs);
      return result(startedAt, effectiveCode(run), outputs);
    }
    case "conversion": {
      const sourceIdentity = await validatedArchive(request.archive, "extract");
      const targetFormat = normalizeFormat(
        request.targetFormat ?? (format === "7z" ? "zip" : "7z"),
        "target format",
      );
      let tempPath: string | undefined;
      let conversionCode = 0;
      try {
        tempPath = await invoke<string>("reserve_temp_extract_path");
        const extract = await extractArgs(request, request.archive, tempPath);
        const extracted = await run7z(extract, sourceIdentity, outputs);
        if (effectiveCode(extracted) !== 0) {
          conversionCode = effectiveCode(extracted);
        } else {
          const children = await invoke<string[]>(
            "list_managed_temp_children",
            {
              path: tempPath,
            },
          );
          if (children.length === 0) {
            throw new Error(
              "Conversion extract produced no files to recompress.",
            );
          }
          const args = withForm(
            "add",
            children,
            () =>
              configureSafeCompressionForm(
                { ...request, format: targetFormat },
                request.target,
                false,
                targetFormat,
              ),
            () => buildArgs(),
          );
          const expectedIdentity = await outputSelectionToken(request.target);
          const compressed = await run7z(args, expectedIdentity, outputs);
          conversionCode = effectiveCode(compressed);
        }
      } finally {
        if (tempPath)
          await invoke("remove_managed_temp_dir", { path: tempPath });
      }
      // Capture duration only after managed conversion cleanup. Cleanup is
      // part of the product operation and must remain included on both the
      // successful and non-zero extraction paths.
      return result(startedAt, conversionCode, outputs);
    }
    case "batch": {
      // Product batch extraction accepts multiple selected archives. Benchmark
      // contract carries one archive; run same archive twice into independent
      // destinations, matching direct benchmark aggregate semantics while each
      // invocation still uses production validation, identity and publication.
      const archives = [request.archive, request.archive];
      const validations = await ensureArchivePaths(
        archives,
        "extract",
        undefined,
        true,
      );
      const identities = validations.map((entry) => entry.identity);
      if (identities.some((identity) => !identity)) {
        throw new Error(
          "Could not capture stable identities for every archive.",
        );
      }
      const separator = request.output.includes("\\") ? "\\" : "/";
      const root = request.output.replace(/[\\/]+$/, "");
      const destinations = [
        `${root}${separator}first`,
        `${root}${separator}second`,
      ];
      for (let index = 0; index < archives.length; index += 1) {
        if (!(await confirmExtractDestination(destinations[index]))) {
          return result(startedAt, -1, outputs);
        }
        const args = await extractArgs(
          request,
          archives[index],
          destinations[index],
        );
        const run = await run7z(args, identities[index], outputs);
        if (effectiveCode(run) !== 0) {
          return result(startedAt, effectiveCode(run), outputs);
        }
      }
      return result(startedAt, 0, outputs);
    }
  }
}

let benchmarkQueue: Promise<void> = Promise.resolve();

/**
 * Execute one benchmark operation in the already-running E2E app. The queue
 * keeps one persistent app session deterministic when a caller submits more
 * than one WebDriver request at once.
 */
export function runArchiveBenchmarkOperation(
  request: ArchiveBenchmarkRequest,
): Promise<ArchiveBenchmarkResult> {
  try {
    validateRequest(request);
  } catch (error) {
    return Promise.reject(error);
  }
  const next = benchmarkQueue.then(async () => {
    const startedAt = performance.now();
    const outputs: string[] = [];
    if (!(await ensureRuntimeReady())) {
      return result(startedAt, 127, outputs);
    }
    return runArchiveOperation(request, startedAt, outputs);
  });
  benchmarkQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
