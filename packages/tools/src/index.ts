// Every standard tool binding, one place to browse.

import type { Binding } from "@behalf-js/core";
import { read } from "./read.js";
import { write } from "./write.js";
import { edit } from "./edit.js";
import { bash } from "./bash.js";

export { read } from "./read.js";
export { write } from "./write.js";
export { edit } from "./edit.js";
export { bash } from "./bash.js";

/** `read`, `write`, `edit`, `bash` concatenated into one list. @public */
export const standardBindings: Binding[] = [read, write, edit, bash];
