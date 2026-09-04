/**
 * Prove that both storage backends keep the same promises.
 *
 * `src/storage.ts` has two implementations and only one of them ever runs in
 * production, so a difference between them is invisible until it is live. The
 * checks below are the contract itself — write at a key, read the same bytes
 * back, overwrite, delete, ask for what is not there — run once against local
 * disk and once against Vercel Blob.
 *
 * The Blob half needs `BLOB_READ_WRITE_TOKEN` and really writes to the store.
 * It confines itself to a run-scoped `contract-test/` prefix and deletes what
 * it wrote, which is the same `delete` the contract is testing.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as api from "../src/api.js";
import {
  BlobStorage,
  LocalStorage,
  PRIVATE_PREFIX,
  isPrivateKey,
  type Storage,
} from "../src/storage.js";

// The token lives in `.env.local` on a developer's machine and in the
// environment everywhere else. Nothing here loads it otherwise, and a silent
// skip of the Blob half is the one outcome this script must not produce.
const ENV_FILE = ".env.local";
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

interface Check {
  backend: string;
  name: string;
  /** `skip` is for a check that cannot run here — never for one that failed. */
  state: "ok" | "fail" | "skip";
  /** Why it failed or was skipped, or what it observed. */
  detail: string;
}

const checks: Check[] = [];

function check(backend: string, name: string, ok: boolean, detail = ""): void {
  checks.push({ backend, name, state: ok ? "ok" : "fail", detail });
}

function skip(backend: string, name: string, detail: string): void {
  checks.push({ backend, name, state: "skip", detail });
}

/** A run of this script must never collide with another one, or with a person. */
const RUN = `contract-test/${Date.now().toString(36)}-${process.pid.toString(36)}`;

const RECORD = Buffer.from(JSON.stringify({ name: "Ada", photos: [] }));
const REWRITTEN = Buffer.from(JSON.stringify({ name: "Ada", photos: ["a"] }));
/** Not a real image; the contract is about bytes, not about pixels. */
const PHOTO = Buffer.from("a face photo stands in for itself here");

/**
 * Which store a key goes to is decided by this one function, so it is worth
 * pinning down on its own: it is what keeps a Reference Photo off a public URL,
 * and it runs before any backend or credential is involved.
 */
function checkPrivateKeyRule(): void {
  const cases: [string, boolean][] = [
    [`${PRIVATE_PREFIX}/laica/ada/reference.png`, true],
    [PRIVATE_PREFIX, true],
    // A capital letter must not be a way out of the private store.
    ["People/laica/ada/reference.png", true],
    ["crops/3f2a.png", false],
    ["renders/laica/instagram/post/3f2a.png", false],
    // A different namespace that merely starts with the same letters.
    ["peoples-choice/3f2a.png", false],
  ];
  for (const [key, expected] of cases) {
    check(
      "key rule",
      `${expected ? "private" : "public"}: ${key}`,
      isPrivateKey(key) === expected,
    );
  }
}

async function runContract(
  backend: string,
  storage: Storage,
  /** False when there is no private store to write a Reference Photo to. */
  privateStore: boolean,
): Promise<void> {
  const recordKey = `${RUN}/person.json`;
  const photoKey = `${PRIVATE_PREFIX}/${RUN}/reference.png`;
  const written: string[] = [];

  try {
    const stored = await storage.putAt(recordKey, RECORD, "application/json");
    written.push(recordKey);
    check(
      backend,
      "putAt returns the key it was given",
      stored.key === recordKey && stored.bytes === RECORD.length,
      `key=${stored.key} bytes=${String(stored.bytes)}`,
    );

    const read = await storage.get(recordKey);
    check(
      backend,
      "get returns the identical bytes",
      read !== null && read.equals(RECORD),
      read === null ? "get returned null" : `${String(read.length)} bytes`,
    );

    await storage.putAt(recordKey, REWRITTEN, "application/json");
    const reread = await storage.get(recordKey);
    check(
      backend,
      "putAt overwrites in place",
      reread !== null && reread.equals(REWRITTEN),
      reread === null ? "get returned null" : reread.toString().slice(0, 40),
    );

    const listed = await storage.list(RUN);
    check(
      backend,
      "an overwrite leaves one object, not two",
      listed.filter((o) => o.key === recordKey).length === 1,
      `${String(listed.length)} object(s) under ${RUN}`,
    );

    check(backend, "get of an unwritten key is null", (await storage.get(`${RUN}/nothing.json`)) === null);

    await storage.delete(recordKey);
    written.splice(written.indexOf(recordKey), 1);
    check(backend, "get after delete is null", (await storage.get(recordKey)) === null);

    let deleteThrew = false;
    try {
      await storage.delete(recordKey);
    } catch {
      deleteThrew = true;
    }
    check(backend, "deleting what is already gone is not an error", !deleteThrew);

    // The property `put` had before this issue and must keep: a retry writes
    // the same bytes to the same key and hands back the same URL.
    const first = await storage.put(RUN, PHOTO, "image/png", "png");
    const second = await storage.put(RUN, PHOTO, "image/png", "png");
    written.push(first.key);
    check(
      backend,
      "content-addressed put stays idempotent",
      first.key === second.key && first.url === second.url,
      first.key,
    );

    let escaped = true;
    try {
      await storage.putAt(`${RUN}/../escaped.txt`, RECORD, "text/plain");
    } catch {
      escaped = false;
    }
    check(backend, "a key cannot climb out of the store", !escaped);

    if (privateStore) {
      const photo = await storage.putAt(photoKey, PHOTO, "image/png");
      written.push(photoKey);
      const readPhoto = await storage.get(photoKey);
      check(
        backend,
        "meco can read back what it stored privately",
        readPhoto !== null && readPhoto.equals(PHOTO),
        photo.url,
      );
      await checkNotPublic(backend, photo.url);
    } else {
      // The store has to exist before anything can be written to it, and only
      // the account owner can create one. Refusing the write is the behaviour
      // worth proving in the meantime: a face photo must never quietly land in
      // the public store.
      let refused = "";
      try {
        await storage.putAt(photoKey, PHOTO, "image/png");
      } catch (err) {
        refused = err instanceof Error ? err.message : String(err);
      }
      check(
        backend,
        "a People key is refused while no private store is configured",
        refused.includes("BLOB_PEOPLE_READ_WRITE_TOKEN"),
        refused || "the write was accepted — a Reference Photo may be public",
      );
      skip(
        backend,
        "a private URL is not publicly readable",
        "no private store yet — see DEPLOY.md, one-time setup",
      );
    }
  } finally {
    // Leaving a Reference Photo behind because a check failed would be the
    // worst possible failure mode for this particular test.
    for (const key of written) await storage.delete(key);
  }
}

/**
 * A Reference Photo's URL must not be enough to fetch it. Only worth asking of
 * a backend whose URLs are actually on the internet: the local backend hands
 * back a dev-server URL, and `src/server.ts` mounts static routes for the three
 * public kinds only, so nothing serves the People prefix there at all.
 */
async function checkNotPublic(backend: string, url: string): Promise<void> {
  if (!url.startsWith("https://")) {
    skip(
      backend,
      "a private URL is not publicly readable",
      "nothing is listening on a local URL here — the dev server mounts the " +
        "three public kinds by name, so the People prefix has no route at all",
    );
    return;
  }
  const res = await fetch(url);
  // Drain, or the socket stays open and the script does not exit.
  await res.arrayBuffer();
  check(
    backend,
    "a private URL is not publicly readable",
    res.status !== 200,
    `unauthenticated GET → ${String(res.status)}`,
  );
}

/** The Gallery lists stored outputs. A Reference Photo is not one. */
async function checkGalleryHidesPeople(root: string): Promise<void> {
  const storage = new LocalStorage(root);
  const crop = await storage.put("crops", PHOTO, "image/png", "png");
  const photoKey = `${PRIVATE_PREFIX}/laica/ada/reference.png`;
  await storage.putAt(photoKey, PHOTO, "image/png");

  const { items } = await api.gallery({ limit: 120 }, storage);
  const keys = items.map((i) => i.key);
  check(
    "gallery",
    "lists the Crop",
    keys.includes(crop.key),
    `${String(items.length)} item(s)`,
  );
  check("gallery", "never lists the People prefix", !keys.some((k) => k.startsWith(`${PRIVATE_PREFIX}/`)));
}

/** One backend blowing up must not hide the results of the other. */
async function attempt(backend: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    check(backend, "the contract ran to the end", false, String(err));
  }
}

checkPrivateKeyRule();

const root = await mkdtemp(join(tmpdir(), "meco-storage-"));
const galleryRoot = await mkdtemp(join(tmpdir(), "meco-gallery-"));
try {
  // Local disk has no notion of a store, so the People prefix is simply a
  // directory nothing serves. The private half of the contract holds there.
  await attempt("local", () => runContract("local", new LocalStorage(root), true));
  await attempt("gallery", () => checkGalleryHidesPeople(galleryRoot));
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(galleryRoot, { recursive: true, force: true });
}

if (process.env.BLOB_READ_WRITE_TOKEN) {
  const privateStore = Boolean(process.env.BLOB_PEOPLE_READ_WRITE_TOKEN);
  await attempt("vercel-blob", () =>
    runContract("vercel-blob", new BlobStorage(), privateStore),
  );
} else {
  check(
    "vercel-blob",
    "the contract ran to the end",
    false,
    "BLOB_READ_WRITE_TOKEN is not set — the Blob half of the contract did not run",
  );
}

const MARK = { ok: "ok    ", fail: "FAIL  ", skip: "skip  " } as const;
for (const c of checks) {
  console.log(
    `${MARK[c.state]} ${c.backend.padEnd(12)} ${c.name}` +
      (c.detail ? `\n         ${c.detail}` : ""),
  );
}

const failed = checks.filter((c) => c.state === "fail");
const skipped = checks.filter((c) => c.state === "skip");
console.log(
  `\n${String(checks.length)} checks, ${String(failed.length)} failed, ` +
    `${String(skipped.length)} skipped`,
);
if (failed.length > 0) process.exitCode = 1;
