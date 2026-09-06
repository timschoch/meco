// Entry point: the runtime surface of `@meco/identify`. Everything under
// `lib/` is private to this package, and every caller and every test crosses
// this file and no other.
export {
  MATCH_MARGIN,
  MATCH_THRESHOLD,
  MIN_FACE_PX,
  NOT_A_FACE_THRESHOLD,
  NUMBER_ON_VEHICLE,
  PRINT_MODEL,
} from "./lib/constants";
export { IdentifyError, type IdentifyErrorCode } from "./lib/errors";
export { identify } from "./lib/identify";
export { NOT_A_FACE_PRINTS, type NotAFacePrint } from "./lib/not-a-face-prints";
export {
  type AnnotateSource,
  type Annotator,
  type EnrolRequest,
  type Enrolment,
  type FaceVerdict,
  type Identification,
  type Identify,
  type IdentifyDeps,
  type MatchRequest,
} from "./lib/types";
