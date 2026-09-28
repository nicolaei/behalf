// Imports both barrels from source (see ./tsconfig.json's `paths`) so the
// engine's own source files are checked with core's StepContext/EdgeContext
// augmentation applied. If the runtime's context builders stop returning a
// value the augmented interfaces accept, this file's project fails to compile.
import "@behalf-js/engine";
import "@behalf-js/core";
