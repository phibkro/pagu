const r = await new Deno.Command("deno", {
  args: ["task", "test"],
  cwd: Deno.cwd(),
  stdout: "inherit",
  stderr: "inherit",
}).output();
Deno.exit(r.code);
