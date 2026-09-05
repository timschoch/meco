/**
 * Which store to address and what to authenticate with. Resolved per store and
 * per call, because a missing Private Store is an error and never a quiet fall
 * back to the Public Store.
 */

/** Vercel Blob sets access per store, so this names a store as much as a mode. */
export type Access = "public" | "private";

/** Which rung of the credential ladder carried the call. */
export type Rung = "oidc" | "token";

/** The options `@vercel/blob` takes to address and authorise one store. */
export type BlobAuth =
  | { readonly oidcToken: string; readonly storeId: string }
  | { readonly token: string };

export type Credential = {
  readonly rung: Rung;
  readonly storeId: string;
  readonly auth: BlobAuth;
};

const STORE_ID_VAR = {
  public: "BLOB_PUBLIC_STORE_ID",
  private: "BLOB_PRIVATE_STORE_ID",
} as const satisfies Record<Access, string>;

const TOKEN_VAR = {
  public: "BLOB_READ_WRITE_TOKEN",
  private: "BLOB_PEOPLE_READ_WRITE_TOKEN",
} as const satisfies Record<Access, string>;

const STORE_NAME = {
  public: "Public Store",
  private: "Private Store",
} as const satisfies Record<Access, string>;

/** An unset variable and one set to the empty string mean the same thing. */
function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

/** The store id, or `null` when that store is not configured at all. */
export function storeIdFor(
  env: NodeJS.ProcessEnv,
  access: Access
): string | null {
  return read(env, STORE_ID_VAR[access]) ?? null;
}

/**
 * Which rung would carry a call to this store, without making one. `null` when
 * the store is not configured or no credential is present.
 */
export function rungFor(env: NodeJS.ProcessEnv, access: Access): Rung | null {
  if (storeIdFor(env, access) === null) return null;
  if (read(env, "VERCEL_OIDC_TOKEN") !== undefined) return "oidc";
  return read(env, TOKEN_VAR[access]) !== undefined ? "token" : null;
}

/**
 * `VERCEL_OIDC_TOKEN` first because it rotates itself; that store's injected
 * read-write token second. There is no third rung: a store meco cannot address
 * is an error, so that a private object can never end up in the Public Store.
 */
export function credentialFor(
  env: NodeJS.ProcessEnv,
  access: Access
): Credential {
  const storeId = storeIdFor(env, access);
  if (storeId === null) {
    throw new Error(
      `@meco/store: ${STORE_ID_VAR[access]} is not set, so the ${STORE_NAME[access]} has no address. Nothing falls back to the other store.`
    );
  }

  const oidcToken = read(env, "VERCEL_OIDC_TOKEN");
  if (oidcToken !== undefined) {
    return { rung: "oidc", storeId, auth: { oidcToken, storeId } };
  }

  const token = read(env, TOKEN_VAR[access]);
  if (token === undefined) {
    throw new Error(
      `@meco/store: neither VERCEL_OIDC_TOKEN nor ${TOKEN_VAR[access]} is set, so nothing can reach the ${STORE_NAME[access]}.`
    );
  }
  return { rung: "token", storeId, auth: { token } };
}
