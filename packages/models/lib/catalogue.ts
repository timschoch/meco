import { createYunet } from "./adapters/yunet/adapter";
import type { Catalogue } from "./detector";
import { runtimeVersion } from "./session";

/**
 * The real Catalogue. Built at import, so a Model whose licence text is
 * missing stops the process before it listens. Order here is Catalogue order:
 * the order Detectors run, warm and are listed in.
 */
export const catalogue: Catalogue = {
  detectors: [createYunet()],
  onnxruntime: runtimeVersion(),
};
