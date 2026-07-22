{ pkgs }:

pkgs.stdenv.mkDerivation {
  pname = "pagu-denial-spike";
  version = "0";
  dontUnpack = true;
  buildPhase = ''
    $CC -std=gnu11 -Wall -Wextra -Werror -O2 \
      ${./denial-spike.c} -o pagu-denial-observer
    $CC -std=gnu11 -Wall -Wextra -Werror -Wno-unused-function -O2 -I ${./.} \
      ${./denial-spike-test.c} -o denial-spike-test
  '';
  doCheck = true;
  checkPhase = ''
    ./denial-spike-test
  '';
  installPhase = ''
    mkdir -p $out/bin
    install -m755 pagu-denial-observer $out/bin/
    ln -s pagu-denial-observer $out/bin/pagu-denial-spike
  '';
}
