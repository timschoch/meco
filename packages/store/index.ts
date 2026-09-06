// Entry point: the runtime surface of `@meco/store`. Everything under `lib/`
// is private to this package.
export {
  MAX_OBJECT_BYTES,
  NAMESPACES,
  type Namespace,
  isPrivate,
} from "./lib/keys";
export {
  type BlobStoreConfig,
  type PutResult,
  type Store,
  type StoredObject,
  blobStore,
} from "./lib/blob";
