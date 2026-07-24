import { assertThrows } from "@std/assert";
import {
  assertBoxSurfacesEquivalent,
  type CommandObservation,
} from "./box-command-journey.ts";

const PASS: CommandObservation = {
  success: true,
  code: 0,
  stdout: "same\n",
  stderr: "",
};

Deno.test("law: pagu box and pagu-box observations are identical", () => {
  assertBoxSurfacesEquivalent([{
    name: "launch",
    pagu: PASS,
    compatibility: { ...PASS },
  }]);
});

Deno.test("falsifier: box command comparison catches launch drift", () => {
  assertThrows(
    () =>
      assertBoxSurfacesEquivalent([{
        name: "launch",
        pagu: { ...PASS, success: false, code: 1 },
        compatibility: { ...PASS, success: false, code: 1 },
      }]),
    Error,
    "did not succeed",
  );
  for (
    const [message, changed] of [
      ["success status differs", { ...PASS, success: false }],
      ["exit code differs", { ...PASS, code: 1 }],
      ["stdout differs", { ...PASS, stdout: "different\n" }],
      ["stderr differs", { ...PASS, stderr: "different\n" }],
    ] as const
  ) {
    assertThrows(
      () =>
        assertBoxSurfacesEquivalent([{
          name: "launch",
          pagu: PASS,
          compatibility: changed,
        }]),
      Error,
      message,
    );
  }
});
