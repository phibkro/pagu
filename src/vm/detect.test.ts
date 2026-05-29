import { assertEquals } from "@std/assert";
import { detectVM } from "./detect.ts";

Deno.test("detectVM: recursion guard — PAGU_IN_VM set → none (never wrap inside the guest)", async () => {
  const prev = Deno.env.get("PAGU_IN_VM");
  Deno.env.set("PAGU_IN_VM", "1");
  try {
    assertEquals(await detectVM(), "none");
  } finally {
    if (prev === undefined) Deno.env.delete("PAGU_IN_VM");
    else Deno.env.set("PAGU_IN_VM", prev);
  }
});
