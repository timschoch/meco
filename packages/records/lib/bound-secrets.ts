/**
 * A **Bound Secret** is a value a statement binds that must never reach a log:
 * the SHA-256 of a bearer key, and a Face Print.
 *
 * A statement that binds one cannot report its own failure, because neither
 * half of what arrives is safe to pass on. drizzle does not rethrow what the
 * driver raised — it wraps it in a `DrizzleQueryError` whose own message is the
 * statement followed by its bound parameters — and Postgres quotes the
 * offending value back in its own message besides, as
 * `Key (key_hash)=(…) already exists`. So neither the message nor the `cause`
 * chain may travel out of records.
 *
 * What may travel is the SQLSTATE: five characters naming a class of failure,
 * carrying nothing of the row. Without it nothing outside could tell a unique
 * violation from a server it never reached.
 */

/** Postgres' SQLSTATE: five characters, digits and capitals, and nothing else. */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * The SQLSTATE of a failure, wherever down the `cause` chain the driver left
 * it. Shaped rather than merely present, so a Node error's `code` — `ECONNRESET`
 * and its kind — is not mistaken for one.
 */
export const sqlstateOf = (error: unknown): string | null => {
  for (
    let at = error;
    at instanceof Object;
    at = (at as { cause?: unknown }).cause
  ) {
    if ("code" in at && typeof at.code === "string" && SQLSTATE.test(at.code)) {
      return at.code;
    }
  }
  return null;
};

/**
 * The failure of a statement that bound a secret, restated so it carries none.
 *
 * Deliberately without a `cause`: the chain is the leak, and an `Error` whose
 * cause is a `DrizzleQueryError` prints the parameters again the moment anything
 * inspects it.
 */
export const withoutBoundSecrets = (doing: string, error: unknown): Error => {
  const code = sqlstateOf(error);
  return new Error(
    `@meco/records: ${doing} failed${code === null ? "" : ` (SQLSTATE ${code})`}.`
  );
};
