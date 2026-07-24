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
      devSystem = "x86_64-linux";
      devPkgs = nixpkgs.legacyPackages.${devSystem};
    in
    {
      packages = forEachSystem (
        system: pkgs:
        let
          categoryProfiles = builtins.path {
            path = ./profiles;
            name = "pagu-category-profiles-v0";
          };
          paguSource = builtins.path {
            path = ./src;
            name = "pagu-source";
            filter = path: _type: !(nixpkgs.lib.hasSuffix ".test.ts" path);
          };
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
                PAGU_PROFILE_DIR=${categoryProfiles} \
                exec ${pkgs.deno}/bin/deno run --quiet --no-prompt \
                --allow-read --allow-write --allow-env --allow-net --allow-run \
                ${paguSource}/gate/cli.ts "$@"
            '';
          };
          paguMcp = pkgs.writeShellApplication {
            name = "pagu-mcp";
            runtimeInputs = [ pkgs.deno ];
            text = ''
              exec deno run --quiet --no-prompt \
                --allow-env=PAGU_REQUEST_SOCKET \
                --allow-read=/run/pagu/request.sock \
                --allow-write=/run/pagu/request.sock \
                ${paguSource}/mcp/cli.ts "$@"
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
        packages = with devPkgs; [
          deno
          git-cliff
          bubblewrap
          git
        ];

        shellHook = ''
          echo "[pagu] deno $(deno --version | head -1 | cut -d' ' -f2) · git-cliff $(git-cliff --version | cut -d' ' -f2) · bwrap $(bwrap --version | cut -d' ' -f2)"
          echo "  deno task ci   — full gate (fmt · lint · check · layers · docs · test)"
          echo "  deno task test — suite (spawns bwrap for the real cage/runner)"
        '';
      };
    };
}
