{
  description = "pagu — local-first, security-first agent runtime (Deno). Self-contained dev shell.";

  # Self-contained: pins its OWN nixpkgs, no dependency on the private homelab
  # flake — pagu must build anywhere nix runs.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forEachSystem = f: nixpkgs.lib.genAttrs systems (system: f system nixpkgs.legacyPackages.${system});
      /*
        THE source fact for every packaged pagu identity claim.

        `self` is the only thing in the build that can prove which tree produced
        these executables, so it is the single home of that fact: no wrapper, no
        shell script, and no checked-in constant may state a revision. What
        cannot be proven is reported as unknown rather than approximated —
        `state = "unknown"` with a null revision is the honest answer for a
        source whose flake reference carries no revision at all, and it can
        never be mistaken for a build that was actually pinned.

        A dirty tree keeps its base revision AND says so: the revision alone
        does not determine behavior there, which is exactly why `sourceHash`
        (the exact tree hash nix computed) travels with it.
      */
      buildProvenance =
        if self ? rev then
          {
            state = "clean";
            revision = self.rev;
            sourceHash = self.narHash;
          }
        else if self ? dirtyRev then
          {
            state = "dirty";
            revision = nixpkgs.lib.removeSuffix "-dirty" self.dirtyRev;
            sourceHash = self.narHash;
          }
        else
          {
            state = "unknown";
            revision = null;
            sourceHash = self.narHash or null;
          };
      devSystem = "x86_64-linux";
      devPkgs = nixpkgs.legacyPackages.${devSystem};
      /*
        Claw Patrol is the outside egress plane pagu composes with (ADR-0014).
        It is not in nixpkgs yet, so this pins the upstream release binary.

        The hash is the one *upstream publishes* in SHA256SUMS beside the
        asset, not one computed locally from whatever the network returned —
        the point of pinning a credential-handling gateway is to bind to the
        publisher's claim, and re-hashing our own download would only certify
        that we downloaded it consistently.

        Dev-shell only: pagu neither builds nor ships this. `gateway:
        "required"` refuses a launch when no gateway is observed, so a missing
        binary is a loud launch failure, never a silent fallback to open
        network.
      */
      clawpatrol = devPkgs.stdenvNoCC.mkDerivation rec {
        pname = "clawpatrol";
        version = "0.5.8";
        src = devPkgs.fetchurl {
          url = "https://github.com/denoland/clawpatrol/releases/download/v${version}/clawpatrol-linux-amd64";
          hash = "sha256-DTFx7UQTw+24xbPHd50m+nogdPnNNrywpiWn/6JE/tc=";
        };
        dontUnpack = true;
        nativeBuildInputs = [ devPkgs.autoPatchelfHook ];
        installPhase = ''
          install -Dm755 $src $out/bin/clawpatrol
        '';
        meta.mainProgram = "clawpatrol";
      };

    in
    {
      packages = forEachSystem (
        system: pkgs:
        let
          categoryProfiles = builtins.path {
            path = ./profiles;
            name = "pagu-category-profiles-v0";
          };
          /*
            The store copy carries `deno.json`, `deno.lock`, and `vendor/`
            alongside `src/`, so the packaged CLI resolves every dependency
            from the store instead of fetching it at first run. Before this,
            the gate CLI happened to import nothing external, so hermeticity
            was true by accident; one stdlib import would have turned startup
            into a network call with no integrity check, inside a process
            already holding --allow-net --allow-write --allow-run.

            Paired with `--cached-only` in the wrapper below, a missing
            vendored module fails loudly at launch rather than silently
            reaching the network.
          */
          paguSourceTree = builtins.path {
            path = ./.;
            name = "pagu-source-tree";
            filter =
              path: _type:
              let
                rel = nixpkgs.lib.removePrefix (toString ./. + "/") (toString path);
                keep =
                  rel == "deno.json"
                  || rel == "deno.lock"
                  || rel == "src"
                  || nixpkgs.lib.hasPrefix "src/" rel
                  || rel == "vendor"
                  || nixpkgs.lib.hasPrefix "vendor/" rel;
              in
              keep && !(nixpkgs.lib.hasSuffix ".test.ts" path);
          };
          /*
            The injection point, and the derivation edge the provenance contract
            asks for. Overwriting one file in the store copy of the source — the
            copy BOTH `pagu` and `pagu-mcp` execute from — is what makes the two
            packaged entrypoints structurally incapable of disagreeing about
            which build they are. There is no second substitution site to keep
            in sync, and a renamed target fails the build loudly instead of
            leaving the honest-unknown default behind and looking fine.

            The checked-in `src/provenance/build.json` is the development
            answer: a plain `deno run` is not a packaged artifact, so it reports
            unknown.
          */
          paguSource = pkgs.runCommand "pagu-source" { } ''
            cp -R ${paguSourceTree} "$out"
            chmod -R u+w "$out"
            test -f "$out/src/provenance/build.json" || {
              echo "pagu-source: build-provenance injection target is missing" >&2
              exit 1
            }
            cp ${pkgs.writeText "pagu-build-provenance.json" (builtins.toJSON buildProvenance)} \
              "$out/src/provenance/build.json"
          '';
          paguSkill = builtins.path {
            path = ./skills/pagu;
            name = "pagu-agent-skill";
          };
          paguPiExtension = pkgs.writeText "pagu-pi-extension.ts" (
            builtins.replaceStrings [ "@PAGU_MCP_COMMAND@" ] [ "${paguMcp}/bin/pagu-mcp" ] (
              builtins.readFile ./integrations/pi/pagu.ts
            )
          );
          pagu = pkgs.writeShellApplication {
            name = "pagu";
            # Keep the caller PATH untouched until subcommand dispatch. In
            # particular, `pagu box` must enter the exact pagu-box wrapper with
            # the same environment as invoking that compatibility executable
            # directly.
            runtimeInputs = [ ];
            text = ''
              if [[ "''${1-}" == "box" ]]; then
                shift
                exec ${paguBox}/bin/pagu-box "$@"
              fi
              if [[ "''${1-}" == "mcp" ]]; then
                shift
                exec ${paguMcp}/bin/pagu-mcp "$@"
              fi
              export PATH=${
                pkgs.lib.makeBinPath [
                  pkgs.deno
                  paguBox
                  paguMcp
                ]
              }:"$PATH"
              PAGU_MCP_COMMAND=${paguMcp}/bin/pagu-mcp \
                PAGU_PI_EXTENSION=${paguPiExtension} \
                PAGU_SKILL_PATH=${paguSkill}/SKILL.md \
                PAGU_PROFILE_DIR=${categoryProfiles} \
                exec ${pkgs.deno}/bin/deno run --quiet --no-prompt \
                --cached-only --config ${paguSource}/deno.json \
                --allow-read --allow-write --allow-env --allow-net --allow-run \
                ${paguSource}/src/gate/cli.ts "$@"
            '';
          };
          paguMcp = pkgs.writeShellApplication {
            name = "pagu-mcp";
            runtimeInputs = [ pkgs.deno ];
            text = ''
              exec deno run --quiet --no-prompt \
                --cached-only --config ${paguSource}/deno.json \
                --allow-env=PAGU_REQUEST_SOCKET \
                --allow-read=/run/pagu/request.sock \
                --allow-write=/run/pagu/request.sock \
                ${paguSource}/src/mcp/cli.ts "$@"
            '';
          };
          paguBox =
            if pkgs.stdenv.isLinux then
              import ./box/src/linux.nix { inherit pkgs; }
            else if pkgs.stdenv.isDarwin then
              import ./box/src/darwin.nix { inherit pkgs; }
            else
              throw "pagu-box: unsupported system ${system}";
        in
        {
          default = pagu;
          inherit pagu;
          pagu-box = paguBox;
        }
        // pkgs.lib.optionalAttrs pkgs.stdenv.isLinux {
          pagu-denial-spike = import ./box/src/denial-spike.nix { inherit pkgs; };
        }
      );

      homeManagerModules.default = import ./box/modules/home-manager.nix self;

      formatter = forEachSystem (_: pkgs: pkgs.nixfmt-rfc-style);

      devShells.${devSystem}.default = devPkgs.mkShell {
        # deno — the runtime + task runner (deno.json tasks). git-cliff —
        # CHANGELOG generation (cliff.toml). git — VCS. bubblewrap is included
        # because pagu's RUNNER spawns bwrap to build its OS-sandbox tier
        # (src/runner/sandbox.ts); the suite exercises the real cage, so bwrap
        # must be on PATH.
        #
        # Deliberate non-choice: pagu gets NO scripts/dev-sandbox.sh wrapper,
        # unlike the pnpm repos. (1) Deno's supply-chain surface is small —
        # explicit pinned jsr/npm imports, no postinstall scripts, per-task
        # --allow-* perms are already the boundary. (2) Wrapping `deno task
        # test` in an outer bwrap would nest user namespaces and break the
        # runner's OWN bwrap. pagu's isolation is its runtime design, not a
        # dev-command wrapper.
        packages = [
          devPkgs.deno
          devPkgs.git-cliff
          devPkgs.bubblewrap
          devPkgs.git
          clawpatrol
        ];

        shellHook = ''
          echo "[pagu] deno $(deno --version | head -1 | cut -d' ' -f2) · git-cliff $(git-cliff --version | cut -d' ' -f2) · bwrap $(bwrap --version | cut -d' ' -f2)"
          echo "  deno task ci   — full gate (fmt · lint · check · layers · docs · test)"
          echo "  deno task test — suite (spawns bwrap for the real cage/runner)"
          echo "  clawpatrol run -- pagu HARNESS — gated-egress journey (ADR-0014)"
        '';
      };
    };
}
