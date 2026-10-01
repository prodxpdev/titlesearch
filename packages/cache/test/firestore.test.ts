// Runs the conformance suites against the Firestore emulator when
// FIRESTORE_EMULATOR_HOST is set (CI starts one); skipped otherwise.

import { describe } from "vitest";
import { FirestoreStore } from "../src/firestore.js";
import { blobConformance, cacheConformance } from "./conformance.js";

const host = process.env.FIRESTORE_EMULATOR_HOST;
let run = 0;

const factory = (now: () => number) => ({
  // A fresh project per test isolates the data; the emulator accepts any project ID.
  store: new FirestoreStore({
    projectId: `titlesearch-test-${process.pid}-${++run}`,
    accessToken: async () => "owner",
    emulatorOrigin: `http://${host}`,
    now,
  }),
});

// In the CI job that starts the emulators, a missing one is a failure, not a skip.
if (process.env.TITLESEARCH_REQUIRE_EMULATORS && !process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error("FIRESTORE_EMULATOR_HOST isn't set, but the emulators are required.");

describe.skipIf(!host)("Firestore emulator", () => {
  cacheConformance("firestore", factory);
  blobConformance("firestore", factory);
});
