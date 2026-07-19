self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.programs.pagu-box;
  pkg = self.packages.${pkgs.stdenv.hostPlatform.system}.pagu-box;
in
{
  options.programs.pagu-box = {
    enable = lib.mkEnableOption "pagu-box, the sandboxed agent launcher";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkg;
      description = "The pagu-box package to install.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
  };
}
