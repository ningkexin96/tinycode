import assert from "node:assert";
import { add } from "./add.js";

assert.equal(add(1, 2), 3);
assert.equal(add(-1, 1), 0);
assert.equal(add(0, 0), 0);
console.log("all tests passed");
