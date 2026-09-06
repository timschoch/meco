// Entry point. Everything under `lib/` is private to this package, and frame's
// own tests come in this way too: no test reaches an internal algorithm.
export { frameCrop } from "./lib/frame-crop";
export { frameVariants } from "./lib/variants";
export { projectIntoFrame } from "./lib/project";
export {
  MAX_OCCLUSION_ZONES,
  PHI_LINES,
  type CropWindow,
  type FallbackRung,
  type FrameInput,
  type Framing,
  type ResolvedBy,
  type VariantRequest,
  type VariantsInput,
} from "./lib/framing";
