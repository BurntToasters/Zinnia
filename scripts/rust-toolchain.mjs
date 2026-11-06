#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import console from "node:console";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isDirectExecutionOf } from "./direct-execution.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const exactVersionPattern = /^\d+\.\d+\.\d+$/u;

function parseTomlString(value, key) {
  const match = value.match(/^(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/u);
  if (!match) {
    throw new Error(
      `rust-toolchain.toml must define ${key} as a quoted string`,
    );
  }
  return match[1] ?? match[2];
}

function parseStringArray(value) {
  const match = value.match(/^\[([\s\S]*)\]\s*(?:#.*)?$/u);
  if (!match) {
    throw new Error(
      "rust-toolchain.toml components must be an array of strings",
    );
  }
  const body = match[1].trim();
  if (!body) return [];
  return body
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const component = parseTomlString(item, "components");
      if (!component) {
        throw new Error(
          "rust-toolchain.toml components must be an array of strings",
        );
      }
      return component;
    });
}

function readToolchainValues(contents) {
  const lines = contents.replace(/\r\n?/gu, "\n").split("\n");
  const values = new Map();
  let section = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/u);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    if (section !== "toolchain") continue;

    const assignment = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/u);
    if (!assignment) {
      throw new Error(
        `rust-toolchain.toml has a malformed toolchain line: ${trimmed}`,
      );
    }
    const [, key, firstValue] = assignment;
    if (values.has(key)) {
      throw new Error(`rust-toolchain.toml defines ${key} more than once`);
    }

    let value = firstValue.trim();
    if (value.startsWith("[") && !value.includes("]")) {
      while (index + 1 < lines.length) {
        index += 1;
        value = `${value} ${lines[index].trim()}`;
        if (value.includes("]")) break;
      }
    }
    values.set(key, value);
  }

  return values;
}

export function readRustToolchainConfig(root = repositoryRoot) {
  const filePath = path.join(root, "rust-toolchain.toml");
  let contents;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Rust toolchain pin is missing: ${filePath}`, {
        cause: error,
      });
    }
    throw error;
  }

  const values = readToolchainValues(contents);
  const channelValue = values.get("channel");
  let channel = null;
  if (channelValue) {
    try {
      channel = parseTomlString(channelValue, "channel");
    } catch {
      channel = null;
    }
  }
  if (!channel || !exactVersionPattern.test(channel)) {
    throw new Error(
      `rust-toolchain.toml must pin an exact Rust version; found ${channel || "no channel"}`,
    );
  }

  const profileValue = values.get("profile");
  const profile = profileValue
    ? parseTomlString(profileValue, "profile")
    : null;
  if (profileValue && !profile) {
    throw new Error(
      "rust-toolchain.toml must define profile as a non-empty string",
    );
  }

  const componentsValue = values.get("components");
  const components = componentsValue ? parseStringArray(componentsValue) : [];

  return { channel, profile, components };
}

export function readPinnedRustToolchain(root = repositoryRoot) {
  return readRustToolchainConfig(root).channel;
}

export function rustupInstallArgs(toolchain) {
  const config =
    typeof toolchain === "string"
      ? { channel: toolchain, profile: null, components: [] }
      : toolchain;
  if (!exactVersionPattern.test(String(config.channel))) {
    throw new Error(`Invalid Rust toolchain: ${config.channel}`);
  }

  const args = ["toolchain", "install", config.channel];
  if (config.profile) args.push("--profile", config.profile);
  if (config.components?.length) {
    args.push("--component", config.components.join(","));
  }
  return args;
}

export function rustupTargetArgs(toolchain, targets) {
  const channel =
    typeof toolchain === "string" ? toolchain : toolchain?.channel;
  if (!exactVersionPattern.test(String(channel))) {
    throw new Error(`Invalid Rust toolchain: ${channel}`);
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error("--target requires at least one target triple");
  }
  for (const target of targets) {
    if (
      typeof target !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(target)
    ) {
      throw new Error(`Invalid target triple: ${target}`);
    }
  }
  return ["target", "add", "--toolchain", channel, ...targets];
}

function runRustup(args) {
  const result = spawnSync("rustup", args, {
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
  if (result.error) {
    throw new Error(`Unable to run rustup: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(
      `rustup ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`,
    );
  }
}

function parseArguments(argv) {
  if (argv.length === 0) return { mode: "version" };
  if (argv.includes("--print")) {
    if (argv.length !== 1) {
      throw new Error("--print cannot be combined with an action");
    }
    return { mode: "version" };
  }
  if (argv[0] === "--install") {
    if (argv.length !== 1) {
      throw new Error("--install does not accept additional arguments");
    }
    return { mode: "install" };
  }
  if (argv[0] === "--target") {
    return { mode: "target", targets: argv.slice(1) };
  }
  if (argv[0].startsWith("--target=")) {
    return {
      mode: "target",
      targets: [argv[0].slice("--target=".length), ...argv.slice(1)],
    };
  }
  throw new Error(
    `Unknown arguments: ${argv.join(" ")} (expected --print, --install, or --target <triple...>)`,
  );
}

function main(argv = process.argv.slice(2)) {
  const config = readRustToolchainConfig(repositoryRoot);
  const action = parseArguments(argv);
  if (action.mode === "version") {
    console.log(config.channel);
    return;
  }
  if (action.mode === "install") {
    runRustup(rustupInstallArgs(config));
    return;
  }
  runRustup(rustupTargetArgs(config.channel, action.targets));
}

const isMainModule = process.argv[1] && isDirectExecutionOf(import.meta.url);
if (isMainModule) {
  try {
    main();
  } catch (error) {
    console.error(`rust-toolchain: ${error.message}`);
    process.exitCode = 1;
  }
}
