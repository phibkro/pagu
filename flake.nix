{
  description = "pagu — local-first, security-first agent runtime (Deno). Self-contained dev shell.";

  # Self-contained: pins its OWN nixpkgs, no dependency on the private homelab
  # flake — pagu must build anywhere nix runs.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in
    {
      devShells.${system}.default = pkgs.mkShell {
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
        packages = with pkgs; [
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
