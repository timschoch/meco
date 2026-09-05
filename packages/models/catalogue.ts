// Entry point: the real Detectors, and the decode that feeds them. The adapter
// tests reach every adapter through here and read fixtures by path; `decode`
// is exported so those tests hand `adapterConformance` the host's own pixels.
export { catalogue } from "./lib/catalogue";
export type { Catalogue, Detector } from "./lib/detector";
// A Detector whose session cannot be created throws this with
// `model_unavailable`; the app answers 503 and the next request retries.
export { HostError } from "./lib/errors";
export { DECODE_BOUND, decode, type Decoded } from "./lib/decode";
