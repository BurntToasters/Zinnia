// In-process fake of the GitHub REST endpoints the Zinnia release scripts use.
// It keeps releases, assets (with bytes), tags, and a request log, and it
// reproduces the GitHub behaviours the scripts depend on:
//   - drafts are invisible to /releases/tags/:tag and /releases/latest
//   - duplicate asset names return 422 already_exists
//   - a published release with an existing tag keeps that tag's commit
//   - duplicate drafts for one tag are allowed (the "split drafts" problem)
// Unknown routes return 404 and are flagged in the request log.

import crypto from "node:crypto";
import http from "node:http";

const API_HOST = "https://api.github.com";
const UPLOAD_HOST = "https://uploads.github.com";
const REPO_API = "/repos/BurntToasters/zinnia";
const REPO_WEB = "https://github.com/BurntToasters/zinnia";

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

export class FakeGitHub {
  constructor() {
    this.releases = [];
    this.assets = new Map();
    this.tags = new Map();
    this.requests = [];
    this.setupEvents = [];
    this.faults = [];
    this.nextId = 1000;
    this.seq = 0;
    this.baseUrl = null;
    this.server = http.createServer((request, response) => {
      this.#handle(request, response).catch((error) => {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({ message: String(error?.message ?? error) }),
        );
      });
    });
  }

  async start() {
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address();
    this.baseUrl = `http://127.0.0.1:${port}`;
    return this.baseUrl;
  }

  async stop() {
    await new Promise((resolve) => this.server.close(resolve));
  }

  // Test-setup mutators. They change server state directly and are logged as
  // setup events, not as script requests.
  seedRelease({
    tagName,
    name,
    targetCommitish,
    body = "",
    draft = false,
    prerelease = false,
  }) {
    const id = this.#id();
    const release = {
      id,
      tag_name: tagName,
      target_commitish: targetCommitish,
      name,
      body,
      draft,
      prerelease,
      created_at: new Date().toISOString(),
      published_at: draft ? null : new Date().toISOString(),
      assetIds: [],
    };
    this.releases.push(release);
    this.setupEvents.push({ action: "seedRelease", id, tagName, draft });
    return release;
  }

  seedTag(tagName, sha) {
    this.tags.set(tagName, sha);
    this.setupEvents.push({ action: "seedTag", tagName, sha });
  }

  seedAsset(releaseId, name, bytes) {
    const asset = this.#storeAsset(releaseId, name, Buffer.from(bytes));
    this.setupEvents.push({
      action: "seedAsset",
      releaseId,
      name,
      id: asset.id,
    });
    return asset;
  }

  mutateAssetBytes(name, releaseId, bytes) {
    const asset = this.findAsset(releaseId, name);
    if (!asset) throw new Error(`no asset ${name} on release ${releaseId}`);
    asset.bytes = Buffer.from(bytes);
    this.setupEvents.push({ action: "mutateAssetBytes", name, id: asset.id });
    return asset;
  }

  removeAsset(releaseId, name) {
    const asset = this.findAsset(releaseId, name);
    if (!asset) throw new Error(`no asset ${name} on release ${releaseId}`);
    this.#dropAsset(asset);
    this.setupEvents.push({ action: "removeAsset", name, id: asset.id });
  }

  findAsset(releaseId, name) {
    for (const asset of this.assets.values()) {
      if (asset.releaseId === releaseId && asset.name === name) return asset;
    }
    return null;
  }

  findRelease(predicate) {
    return this.releases.find(predicate) ?? null;
  }

  addFault({
    method,
    pathIncludes = "",
    nameStartsWith = "",
    status,
    times = Infinity,
  }) {
    this.faults.push({
      method,
      pathIncludes,
      nameStartsWith,
      status,
      remaining: times,
      hits: 0,
    });
    this.setupEvents.push({
      action: "addFault",
      method,
      nameStartsWith,
      status,
    });
  }

  clearFaults() {
    this.faults = [];
    this.setupEvents.push({ action: "clearFaults" });
  }

  snapshot() {
    return {
      releases: this.releases.map((release) => ({
        id: release.id,
        tag_name: release.tag_name,
        target_commitish: release.target_commitish,
        name: release.name,
        draft: release.draft,
        prerelease: release.prerelease,
        published: Boolean(release.published_at),
        assets: release.assetIds
          .map((id) => this.assets.get(id))
          .filter(Boolean)
          .map((asset) => ({
            id: asset.id,
            name: asset.name,
            size: asset.bytes.length,
            sha256: sha256(asset.bytes),
          })),
      })),
      tags: Object.fromEntries(this.tags),
    };
  }

  #id() {
    this.nextId += 1;
    return this.nextId;
  }

  #storeAsset(releaseId, name, bytes) {
    const release = this.releases.find((item) => item.id === releaseId);
    if (!release) throw new Error(`no release ${releaseId}`);
    const asset = {
      id: this.#id(),
      releaseId,
      name,
      bytes,
      created_at: new Date().toISOString(),
    };
    this.assets.set(asset.id, asset);
    release.assetIds.push(asset.id);
    return asset;
  }

  #dropAsset(asset) {
    this.assets.delete(asset.id);
    const release = this.releases.find((item) => item.id === asset.releaseId);
    if (release) {
      release.assetIds = release.assetIds.filter((id) => id !== asset.id);
    }
  }

  #releaseJson(release) {
    const tag = release.tag_name;
    return {
      id: release.id,
      url: `${API_HOST}${REPO_API}/releases/${release.id}`,
      html_url: `${REPO_WEB}/releases/tag/${encodeURIComponent(tag)}`,
      upload_url: `${UPLOAD_HOST}${REPO_API}/releases/${release.id}/assets{?name,label}`,
      tag_name: tag,
      target_commitish: release.target_commitish,
      name: release.name,
      body: release.body,
      draft: release.draft,
      prerelease: release.prerelease,
      created_at: release.created_at,
      published_at: release.published_at,
      assets: release.assetIds
        .map((id) => this.assets.get(id))
        .filter(Boolean)
        .map((asset) => this.#assetJson(asset)),
    };
  }

  #assetJson(asset) {
    return {
      id: asset.id,
      name: asset.name,
      label: "",
      size: asset.bytes.length,
      state: "uploaded",
      content_type: "application/octet-stream",
      created_at: asset.created_at,
      updated_at: asset.created_at,
      url: `${API_HOST}${REPO_API}/releases/assets/${asset.id}`,
      browser_download_url: `${REPO_WEB}/releases/download/${encodeURIComponent(this.#tagOf(asset))}/${encodeURIComponent(asset.name)}`,
    };
  }

  #tagOf(asset) {
    const release = this.releases.find((item) => item.id === asset.releaseId);
    return release ? release.tag_name : "unknown";
  }

  #faultFor(method, pathname, name) {
    return this.faults.find(
      (fault) =>
        fault.remaining > 0 &&
        (!fault.method || fault.method === method) &&
        pathname.includes(fault.pathIncludes) &&
        (!fault.nameStartsWith ||
          (name ?? "").startsWith(fault.nameStartsWith)),
    );
  }

  #send(response, status, payload, record) {
    const isBuffer = Buffer.isBuffer(payload);
    const body =
      isBuffer || payload === undefined ? payload : JSON.stringify(payload);
    const headers = isBuffer
      ? { "Content-Type": "application/octet-stream" }
      : { "Content-Type": "application/json; charset=utf-8" };
    if (body !== undefined) headers["Content-Length"] = Buffer.byteLength(body);
    response.writeHead(status, headers);
    response.end(body);
    record.status = status;
  }

  #error(response, record, status, message, errors) {
    this.#send(
      response,
      status,
      errors ? { message, errors } : { message },
      record,
    );
  }

  async #handle(request, response) {
    const url = new URL(request.url, "http://fake.invalid");
    const body = await readBody(request);
    const method = request.method ?? "GET";
    const pathname = url.pathname;
    const record = {
      seq: (this.seq += 1),
      at: new Date().toISOString(),
      method,
      path: pathname,
      query: Object.fromEntries(url.searchParams),
      requestBytes: body.length,
      accept: request.headers.accept ?? null,
      status: null,
      unhandled: false,
      faulted: false,
    };
    this.requests.push(record);
    const contentType = String(request.headers["content-type"] ?? "");
    if (body.length > 0 && contentType.includes("json")) {
      record.body = JSON.parse(body.toString("utf8"));
    }

    const repoMatch = pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!repoMatch) {
      record.unhandled = true;
      return this.#error(response, record, 404, "Not Found");
    }
    const rest = repoMatch[3] ?? "";
    const assetName = url.searchParams.get("name") ?? undefined;
    const fault = this.#faultFor(method, pathname, assetName);
    if (fault) {
      fault.remaining -= 1;
      fault.hits += 1;
      record.faulted = true;
      return this.#error(
        response,
        record,
        fault.status,
        "Injected dry-run fault",
      );
    }

    let match;
    if (
      method === "GET" &&
      (match = rest.match(/^\/releases\/latest\/download\/(.+)$/))
    ) {
      const latest = [...this.releases]
        .filter((r) => !r.draft && !r.prerelease)
        .sort((a, b) => b.id - a.id)[0];
      return this.#serveDownload(
        response,
        record,
        latest,
        decodeURIComponent(match[1]),
      );
    }
    if (
      method === "GET" &&
      (match = rest.match(/^\/releases\/download\/([^/]+)\/(.+)$/))
    ) {
      const release = this.releases.find(
        (r) => r.tag_name === decodeURIComponent(match[1]) && !r.draft,
      );
      return this.#serveDownload(
        response,
        record,
        release,
        decodeURIComponent(match[2]),
      );
    }
    if (method === "GET" && rest === "/releases") {
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      const ordered = [...this.releases].sort((a, b) => b.id - a.id);
      const slice = ordered.slice((page - 1) * perPage, page * perPage);
      return this.#send(
        response,
        200,
        slice.map((r) => this.#releaseJson(r)),
        record,
      );
    }
    if (method === "GET" && rest === "/releases/latest") {
      const latest = [...this.releases]
        .filter((r) => !r.draft && !r.prerelease)
        .sort((a, b) => b.id - a.id)[0];
      if (!latest) return this.#error(response, record, 404, "Not Found");
      return this.#send(response, 200, this.#releaseJson(latest), record);
    }
    if (method === "GET" && (match = rest.match(/^\/releases\/tags\/(.+)$/))) {
      const tag = decodeURIComponent(match[1]);
      const release = this.releases.find((r) => r.tag_name === tag && !r.draft);
      if (!release) return this.#error(response, record, 404, "Not Found");
      return this.#send(response, 200, this.#releaseJson(release), record);
    }
    if (method === "POST" && rest === "/releases") {
      return this.#createRelease(response, record, body);
    }
    if ((match = rest.match(/^\/releases\/assets\/(\d+)$/))) {
      const asset = this.assets.get(Number(match[1]));
      if (!asset) return this.#error(response, record, 404, "Not Found");
      record.assetId = asset.id;
      record.assetName = asset.name;
      if (method === "GET") {
        if (String(request.headers.accept ?? "").includes("octet-stream")) {
          return this.#send(response, 200, asset.bytes, record);
        }
        return this.#send(response, 200, this.#assetJson(asset), record);
      }
      if (method === "PATCH") {
        const parsed = record.body ?? {};
        if (parsed.name !== undefined && parsed.name !== asset.name) {
          if (this.findAsset(asset.releaseId, parsed.name)) {
            return this.#alreadyExists(response, record, parsed.name);
          }
          asset.name = parsed.name;
        }
        return this.#send(response, 200, this.#assetJson(asset), record);
      }
      if (method === "DELETE") {
        this.#dropAsset(asset);
        return this.#send(response, 204, undefined, record);
      }
    }
    if ((match = rest.match(/^\/releases\/(\d+)\/assets$/))) {
      const release = this.releases.find((r) => r.id === Number(match[1]));
      if (!release) return this.#error(response, record, 404, "Not Found");
      if (method === "GET") {
        const perPage = Number(url.searchParams.get("per_page") ?? 30);
        const page = Number(url.searchParams.get("page") ?? 1);
        const assets = release.assetIds
          .map((id) => this.assets.get(id))
          .filter(Boolean)
          .map((asset) => this.#assetJson(asset))
          .slice((page - 1) * perPage, page * perPage);
        return this.#send(response, 200, assets, record);
      }
      if (method === "POST") {
        const name = assetName;
        if (!name)
          return this.#error(response, record, 422, "Validation Failed");
        if (this.findAsset(release.id, name)) {
          return this.#alreadyExists(response, record, name);
        }
        const asset = this.#storeAsset(release.id, name, body);
        record.releaseId = release.id;
        record.assetId = asset.id;
        record.assetName = asset.name;
        record.assetBytes = asset.bytes.length;
        return this.#send(response, 201, this.#assetJson(asset), record);
      }
    }
    if ((match = rest.match(/^\/releases\/(\d+)$/))) {
      const release = this.releases.find((r) => r.id === Number(match[1]));
      if (!release) return this.#error(response, record, 404, "Not Found");
      if (method === "GET")
        return this.#send(response, 200, this.#releaseJson(release), record);
      if (method === "PATCH")
        return this.#patchRelease(response, record, release, record.body ?? {});
    }
    if (method === "GET" && (match = rest.match(/^\/git\/ref\/tags\/(.+)$/))) {
      const tag = decodeURIComponent(match[1]);
      if (!this.tags.has(tag))
        return this.#error(response, record, 404, "Not Found");
      return this.#send(
        response,
        200,
        {
          ref: `refs/tags/${tag}`,
          object: { type: "commit", sha: this.tags.get(tag) },
        },
        record,
      );
    }

    record.unhandled = true;
    return this.#error(response, record, 404, "Not Found");
  }

  #serveDownload(response, record, release, name) {
    const asset = release ? this.findAsset(release.id, name) : null;
    if (!asset) return this.#error(response, record, 404, "Not Found");
    record.assetId = asset.id;
    record.assetName = asset.name;
    record.download = true;
    return this.#send(response, 200, asset.bytes, record);
  }

  #alreadyExists(response, record, name) {
    this.#error(response, record, 422, "Validation Failed", [
      {
        resource: "ReleaseAsset",
        code: "already_exists",
        field: "name",
        value: name,
      },
    ]);
  }

  #createRelease(response, record, body) {
    const input = record.body ?? {};
    if (
      !input.draft &&
      this.releases.some((r) => !r.draft && r.tag_name === input.tag_name)
    ) {
      return this.#error(response, record, 422, "Validation Failed", [
        { resource: "Release", code: "already_exists", field: "tag_name" },
      ]);
    }
    const release = {
      id: this.#id(),
      tag_name: input.tag_name,
      target_commitish: input.target_commitish,
      name: input.name ?? input.tag_name,
      body: input.body ?? "",
      draft: input.draft === true,
      prerelease: input.prerelease === true,
      created_at: new Date().toISOString(),
      published_at: null,
      assetIds: [],
    };
    this.releases.push(release);
    if (!release.draft) {
      release.published_at = new Date().toISOString();
      if (!this.tags.has(release.tag_name)) {
        this.tags.set(release.tag_name, release.target_commitish);
      }
    }
    record.releaseId = release.id;
    return this.#send(response, 201, this.#releaseJson(release), record);
  }

  #patchRelease(response, record, release, input) {
    record.releaseId = release.id;
    if (input.draft === false && release.draft) {
      const tag = input.tag_name ?? release.tag_name;
      if (
        this.releases.some(
          (r) => r.id !== release.id && !r.draft && r.tag_name === tag,
        )
      ) {
        return this.#error(response, record, 422, "Validation Failed", [
          { resource: "Release", code: "already_exists", field: "tag_name" },
        ]);
      }
      if (!this.tags.has(tag)) {
        this.tags.set(tag, input.target_commitish ?? release.target_commitish);
      }
      release.published_at = new Date().toISOString();
    }
    for (const field of [
      "tag_name",
      "target_commitish",
      "name",
      "body",
      "draft",
      "prerelease",
    ]) {
      if (input[field] !== undefined) release[field] = input[field];
    }
    return this.#send(response, 200, this.#releaseJson(release), record);
  }
}
