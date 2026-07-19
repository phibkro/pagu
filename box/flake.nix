{
  description = "pagu-box — cross-platform sandboxed launcher for coding agents";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forEachSystem =
        f: nixpkgs.lib.genAttrs systems (system: f system nixpkgs.legacyPackages.${system});
    in
    {
      packages = forEachSystem (
        system: pkgs:
        let
          drv =
            if pkgs.stdenv.isLinux then
              import ./src/linux.nix { inherit pkgs; }
            else if pkgs.stdenv.isDarwin then
              import ./src/darwin.nix { inherit pkgs; }
            else
              throw "pagu-box: unsupported system ${system}";
        in
        {
          default = drv;
          pagu-box = drv;
        }
      );

      homeManagerModules.default = import ./modules/home-manager.nix self;

      formatter = forEachSystem (_: pkgs: pkgs.nixfmt-rfc-style);
    };
}
