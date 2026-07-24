import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  ChildPolicyAttenuationError,
  deriveChildLineage,
  deriveChildPolicy,
  rootLineage,
} from "./index.ts";

function policy(fields: {
  subject?: { agent: string; label: string };
  home?: "rw" | "tmpfs";
  rw?: string[];
  ro?: string[];
  deny?: string[];
  net?: boolean;
  pass?: string[];
  auto?: { "fs.ro": string; scope: "session" }[];
  refuse?: string[];
} = {}): unknown {
  return {
    version: 0,
    subject: fields.subject ?? { agent: "", label: "" },
    fs: {
      home: fields.home ?? "tmpfs",
      rw: fields.rw ?? [],
      ro: fields.ro ?? [],
      deny: fields.deny ?? [],
    },
    net: fields.net ?? false,
    env: { pass: fields.pass ?? [] },
    escalation: {
      auto: fields.auto ?? [],
      refuse: fields.refuse ?? [],
    },
  };
}

const IDENTITY_CONTEXT = { canonicalize: (path: string) => path };

Deno.test("law: child derivation preserves identity while attenuating every authority", () => {
  const child = deriveChildPolicy(
    policy({
      subject: { agent: "codex", label: "parent" },
      home: "rw",
      rw: ["/work"],
      ro: ["/share"],
      deny: ["/work/private"],
      net: true,
      pass: ["TOKEN", "SAFE"],
      auto: [{ "fs.ro": "/share/**", scope: "session" }],
      refuse: ["/work/private/**"],
    }),
    policy({
      subject: { agent: "claude", label: "child" },
      home: "tmpfs",
      rw: ["/work/child"],
      ro: ["/work/reference", "/share/docs"],
      deny: ["/work/child/secret"],
      net: false,
      pass: ["SAFE"],
      auto: [{ "fs.ro": "/share/docs/**", scope: "session" }],
      refuse: ["/work/child/secret/**"],
    }),
    IDENTITY_CONTEXT,
  );

  assertEquals(child.subject, { agent: "claude", label: "child" });
  assertEquals(child.fs.home, "tmpfs");
  assertEquals(child.fs.rw, ["/work/child"]);
  assertEquals(child.fs.ro, ["/work/reference", "/share/docs"]);
  assertEquals(child.fs.deny, [
    "~/.ssh",
    "~/.gnupg",
    "/work/private",
    "/work/child/secret",
  ]);
  assertEquals(child.net, false);
  assertEquals(child.env.pass, ["SAFE"]);
  assertEquals(child.escalation.auto, [{
    "fs.ro": "/share/docs/**",
    scope: "session",
  }]);
  assertEquals(child.escalation.refuse, [
    "/work/private/**",
    "/work/child/secret/**",
  ]);
});

Deno.test("falsifier: child policy cannot regain ancestor filesystem network environment", () => {
  const error = assertThrows(
    () =>
      deriveChildPolicy(
        policy({
          home: "tmpfs",
          rw: ["/work"],
          ro: ["/share"],
          net: false,
          pass: ["SAFE"],
          auto: [{ "fs.ro": "/share/**", scope: "session" }],
        }),
        policy({
          subject: { agent: "hostile", label: "child" },
          home: "rw",
          rw: ["/etc"],
          ro: ["/root"],
          net: true,
          pass: ["SECRET"],
          auto: [{ "fs.ro": "/root/**", scope: "session" }],
        }),
        IDENTITY_CONTEXT,
      ),
    ChildPolicyAttenuationError,
  );

  for (
    const claim of [
      "fs.home=rw",
      'fs.rw widening "/etc"',
      'fs.ro widening "/root"',
      "net=true",
      'env.pass widening "SECRET"',
      "escalation.auto widening",
    ]
  ) {
    assertStringIncludes(error.message, claim);
  }
});

Deno.test("law: narrowest ancestor remains final across child derivation", () => {
  const root = policy({
    rw: ["/authority"],
    net: true,
    pass: ["A", "B"],
  });
  const child = deriveChildPolicy(
    root,
    policy({
      rw: ["/authority/team"],
      net: false,
      pass: ["A"],
    }),
    IDENTITY_CONTEXT,
  );

  const error = assertThrows(
    () =>
      deriveChildPolicy(
        child,
        policy({
          rw: ["/authority/other"],
          net: true,
          pass: ["B"],
        }),
        IDENTITY_CONTEXT,
      ),
    ChildPolicyAttenuationError,
  );
  assertStringIncludes(error.message, 'fs.rw widening "/authority/other"');
  assertStringIncludes(error.message, "net=true");
  assertStringIncludes(error.message, 'env.pass widening "B"');
});

Deno.test("falsifier: child canonical path cannot escape parent through symlink", async () => {
  const root = await Deno.makeTempDir();
  try {
    const allowed = `${root}/allowed`;
    const child = `${allowed}/child`;
    await Deno.mkdir(child, { recursive: true });
    await Deno.symlink("/etc", `${allowed}/escape`);
    const canonicalize = (path: string): string | null => {
      try {
        return Deno.realPathSync(path);
      } catch {
        return null;
      }
    };

    const accepted = deriveChildPolicy(
      policy({ rw: [allowed] }),
      policy({ rw: [child] }),
      { canonicalize },
    );
    assertEquals(accepted.fs.rw, [child]);

    assertThrows(
      () =>
        deriveChildPolicy(
          policy({ rw: [allowed] }),
          policy({ rw: [`${allowed}/escape`] }),
          { canonicalize },
        ),
      ChildPolicyAttenuationError,
      "fs.rw widening",
    );
    assertThrows(
      () =>
        deriveChildPolicy(
          policy({ rw: [allowed] }),
          policy({ rw: [`${allowed}/missing`] }),
          { canonicalize },
        ),
      ChildPolicyAttenuationError,
      "fs.rw widening",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("falsifier: literal filesystem wildcard cannot become its parent directory", () => {
  for (const field of ["rw", "ro"] as const) {
    const error = assertThrows(
      () =>
        deriveChildPolicy(
          policy({ [field]: [`/${field}-root/**`] }),
          policy({ [field]: [`/${field}-root`] }),
          IDENTITY_CONTEXT,
        ),
      ChildPolicyAttenuationError,
    );
    assertStringIncludes(
      error.message,
      `fs.${field} widening "/${field}-root"`,
    );
  }
});

Deno.test("law: rw parent home may attenuate to explicit child home scopes", () => {
  const canonicalize = (path: string) => {
    if (path === "$HOME" || path === "~") return "/home/test";
    if (path.startsWith("$HOME/")) return `/home/test${path.slice(5)}`;
    if (path.startsWith("~/")) return `/home/test${path.slice(1)}`;
    return path;
  };
  const child = deriveChildPolicy(
    policy({ home: "rw" }),
    policy({
      home: "tmpfs",
      rw: ["$HOME/work"],
      ro: ["~/reference"],
    }),
    { canonicalize },
  );

  assertEquals(child.fs.home, "tmpfs");
  assertEquals(child.fs.rw, ["/home/test/work"]);
  assertEquals(child.fs.ro, ["/home/test/reference"]);
});

Deno.test("law: lineage distinguishes host actor from ancestor position", () => {
  const root = rootLineage("box-root", {
    kind: "human",
    id: "operator",
  });
  const child = deriveChildLineage(root, "box-child", {
    kind: "agent",
    id: "parent-agent",
  });
  const grandchild = deriveChildLineage(child, "box-grandchild", {
    kind: "agent",
    id: "child-agent",
  });

  assertEquals(root, {
    version: 0,
    box: "box-root",
    parent: null,
    depth: 0,
    host: {
      actor: { kind: "human", id: "operator" },
      position: "operator",
    },
  });
  assertEquals(child.parent, "box-root");
  assertEquals(child.depth, 1);
  assertEquals(child.host.position, "parent-inhabitant");
  assertEquals(grandchild.parent, "box-child");
  assertEquals(grandchild.depth, 2);
  assertThrows(
    () =>
      deriveChildLineage(root, "box-root", {
        kind: "agent",
        id: "duplicate",
      }),
    TypeError,
    "distinct",
  );
});
