// Entry point: the runtime surface of `@meco/store`. Everything under `lib/`
// is private to this package.
export {
  MAX_OBJECT_BYTES,
  NAMESPACES,
  type Namespace,
  isPrivate,
  storeKeyFor,
} from "./lib/keys";
export {
  type BlobStoreConfig,
  type Listing,
  type PutResult,
  type Store,
  type StoredObject,
  type UploadTarget,
  blobStore,
} from "./lib/blob";
export { memoryStore } from "./lib/memory";
export { MAX_SIGNED_URL_SECONDS } from "./lib/urls";
