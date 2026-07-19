# Example home-manager configuration consuming pagu-box.
{
  description = "Example consuming pagu-box";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    home-manager.url = "github:nix-community/home-manager/release-26.05";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";

    pagu-box.url = "github:phibkro/pagu-box";
    pagu-box.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    {
      nixpkgs,
      home-manager,
      pagu-box,
      ...
    }:
    {
      homeConfigurations."you@your-host" = home-manager.lib.homeManagerConfiguration {
        pkgs = nixpkgs.legacyPackages.x86_64-darwin;
        modules = [
          pagu-box.homeManagerModules.default
          (
            { ... }:
            {
              home.username = "you";
              home.homeDirectory = "/Users/you";
              home.stateVersion = "26.05";

              programs.pagu-box.enable = true;
            }
          )
        ];
      };
    };
}
