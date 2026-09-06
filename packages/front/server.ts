// Entry point: the Function Vercel runs. `GATEWAY_URL` is the service binding
// to the gateway container (`vercel.json`), injected at runtime only, so a
// deployment without it fails on the first request with the variable named.
import { createFront } from "./index";

const upstream = process.env["GATEWAY_URL"];
if (upstream === undefined || upstream === "") {
  throw new Error("front cannot start: GATEWAY_URL is unset");
}

export default createFront({ upstream });
