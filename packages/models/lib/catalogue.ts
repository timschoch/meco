import { createDfine } from "./adapters/dfine/adapter";
import { createEdgeface } from "./adapters/edgeface/adapter";
import { createYunet } from "./adapters/yunet/adapter";
import type { Catalogue } from "./detector";
import { runtimeVersion } from "./session";

/**
 * The real Catalogue. Built at import, so a Model whose licence text is
 * missing stops the process before it listens. Order here is Catalogue order:
 * the order Models run, warm and are listed in — every Detector, then every
 * Enricher over what they found.
 */
export const catalogue: Catalogue = {
  detectors: [createYunet(), createDfine()],
  enrichers: [createEdgeface()],
  onnxruntime: runtimeVersion(),
};
