import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  APP_ID,
  E2E_WEBVIEW2_BROWSER_ARGS,
  createE2eProfile,
  settingsDirForProfile,
  windowsHomeDriveAndPath,
  windowsProfilePaths,
} from "../../e2e/helpers/profile.js";

const createdProfiles: string[] = [];

afterEach(() => {
  for (const dir of createdProfiles.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Windows E2E profile isolation", () => {
  it("keeps AppData under USERPROFILE", () => {
    expect(settingsDirForProfile("/tmp/profile", "win32")).toBe(
      path.join("/tmp/profile", "home", "AppData", "Roaming", APP_ID),
    );
    const paths = windowsProfilePaths("/tmp/profile/home");
    expect(paths.roaming).toBe(
      path.join("/tmp/profile/home", "AppData", "Roaming"),
    );
    expect(paths.webview2).toBe(
      path.join("/tmp/profile/home", "AppData", "Local", "ZinniaWebView2"),
    );
  });

  it("derives HOMEDRIVE and HOMEPATH from a Windows home", () => {
    expect(
      windowsHomeDriveAndPath("C:\\Users\\tester\\home", path.win32),
    ).toEqual({
      HOMEDRIVE: "C:",
      HOMEPATH: "\\Users\\tester\\home",
    });
  });

  it("seeds settings and WebView2 dirs for a Windows profile", () => {
    const profile = createE2eProfile(undefined, "win32");
    createdProfiles.push(profile.profileDir);
    const home = path.join(profile.profileDir, "home");
    const paths = windowsProfilePaths(home);
    expect(profile.env.APPDATA).toBe(paths.roaming);
    expect(profile.env.LOCALAPPDATA).toBe(paths.local);
    expect(profile.env.USERPROFILE).toBe(home);
    expect(profile.env.WEBVIEW2_USER_DATA_FOLDER).toBe(paths.webview2);
    expect(profile.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS).toBe(
      E2E_WEBVIEW2_BROWSER_ARGS,
    );
    expect(
      fs.existsSync(path.join(paths.settingsRoaming, "settings.json")),
    ).toBe(true);
    expect(fs.existsSync(path.join(paths.settingsLocal, "settings.json"))).toBe(
      true,
    );
    expect(fs.existsSync(paths.webview2)).toBe(true);
  });
});
