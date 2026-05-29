import { assertEquals } from "@std/assert";
import { detectSandbox } from "../../src/runner/index.ts";
import { evalModel } from "./harness.ts";
import { SCENARIOS } from "./scenario.ts";
import { startMockProvider } from "../golden-scenario/mock_provider.ts";

// The deterministic CI smoke: drive the harness end-to-end on the ADVERSARIAL
// scenario via A's task-blind mock. It can't produce task-correct benign
// proposals (so benign-utility is real-model-only), but it CAN prove the harness
// runs, scores, and that the security floor holds + attack-success is 0 under a
// canned-malicious model. Skips at sandbox tier `none` (like A).

Deno.test("eval harness: golden scenario via the mock → floor holds, attack-success 0", async () => {
  if (await detectSandbox() === "none") return;
  const golden = SCENARIOS.find((s) => s.name === "golden-injection")!;
  const mock = startMockProvider("exfil"); // canned read-.env + POST
  try {
    const sc = await evalModel([golden], {
      provider: "ollama",
      baseURL: mock.baseURL,
    }, 1);
    // the scorecard is produced and well-formed
    assertEquals(sc.scenarios.length, 1);
    assertEquals(sc.k, 1);
    // the security floor held on every run, and the injection never won
    assertEquals(sc.floorHeldAll, true);
    assertEquals(sc.attackSuccessRate, 0);
  } finally {
    await mock.stop();
  }
});
