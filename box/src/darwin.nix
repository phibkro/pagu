{ pkgs }:

# macOS mechanism: sandbox-exec (Apple's seatbelt LSM).
#
# Profile-driven policy. `--profile=NAME` selects which .sb file gets passed
# to sandbox-exec. CLI flags layer extra denies / extra env passthrough on
# top by composing additional profile snippets at runtime.
#
# The .sb FILES are the security boundary, not this script — read them.

let
  profilesDir = ./profiles;
in
pkgs.writeShellApplication {
  name = "pagu-box";
  text = ''
    set -euo pipefail

    PROFILE="default"
    EXTRA_ALLOW=()
    EXTRA_RO_ALLOW=()
    EXTRA_DENY=()
    PASS_ENV_USER=()
    NO_NET=0

    while [ $# -gt 0 ]; do
      case "$1" in
        --profile=*)    PROFILE="''${1#--profile=}"; shift ;;
        --profile)      PROFILE="$2"; shift 2 ;;
        --allow)        EXTRA_ALLOW+=("$2"); shift 2 ;;
        --ro-allow)     EXTRA_RO_ALLOW+=("$2"); shift 2 ;;
        --deny)         EXTRA_DENY+=("$2"); shift 2 ;;
        --env)          PASS_ENV_USER+=("''${2%%=*}"); shift 2 ;;
        --no-net)       NO_NET=1; shift ;;
        --journal)      shift ;;  # no-op on darwin — `log show` uses its own auth model
        --)             shift; break ;;
        -h|--help)
          cat <<'USAGE'
    pagu-box [OPTIONS] -- COMMAND [ARGS...]
    pagu-box [OPTIONS] COMMAND [ARGS...]

      --profile=NAME  default | strict | paranoid | loose  (default: default)
      --allow PATH    extra RW allow — appends (allow file-read*/write*) (deny-by-default
                      profiles only — no-op for default/loose since they allow by default)
      --ro-allow PATH extra RO allow — appends (allow file-read*) only (deny-by-default
                      profiles only — no-op for default/loose)
      --deny PATH     extra deny — appends a (deny) clause to the seatbelt profile
      --env VAR       forward env var through the scrub (repeatable)
      --no-net        drop network access (composes onto the chosen profile)
      --journal       Linux-only flag accepted as a no-op on darwin
                      (macOS uses `log show` which has its own auth model)
      -h, --help      this text

    Profiles (this OS — macOS/sandbox-exec):
      default     allow-by-default;  secret deny-list applied
      strict      deny-by-default;   $PWD + ~/.claude RW; net allowed
      paranoid    deny-by-default;   $PWD RW only;        net DENIED
      loose       allow-by-default;  minimal deny-list (SSH, GPG, Keychain)
    USAGE
          exit 0 ;;
        *)              break ;;
      esac
    done
    [ $# -eq 0 ] && { echo "pagu-box: no command given" >&2; exit 64; }

    case "$PROFILE" in
      default|strict|paranoid|loose) ;;
      *)
        echo "pagu-box: unknown profile '$PROFILE' (try default|strict|paranoid|loose)" >&2
        exit 64
        ;;
    esac

    BASE="${profilesDir}/$PROFILE.sb"
    [ -f "$BASE" ] || { echo "pagu-box: profile file missing: $BASE" >&2; exit 70; }

    # Compose extra clauses (--allow, --ro-allow, --deny, --no-net) onto the
    # profile at runtime.
    PROFILE_FILE="$BASE"
    NEED_MERGE=0
    [ ''${#EXTRA_ALLOW[@]} -gt 0 ]    && NEED_MERGE=1
    [ ''${#EXTRA_RO_ALLOW[@]} -gt 0 ] && NEED_MERGE=1
    [ ''${#EXTRA_DENY[@]} -gt 0 ]    && NEED_MERGE=1
    [ "$NO_NET" -eq 1 ]              && NEED_MERGE=1

    if [ "$NEED_MERGE" -eq 1 ]; then
      MERGED="$(mktemp -t pagu-box.XXXXXX.sb)"
      trap 'rm -f "$MERGED"' EXIT
      cat "$BASE" > "$MERGED"

      # --allow / --ro-allow are no-ops under default/loose (allow-by-default)
      # but meaningful under strict/paranoid (deny-by-default).
      for p in "''${EXTRA_ALLOW[@]}"; do
        if [ -d "$p" ]; then
          printf '(allow file-read* file-write* (subpath "%s"))\n' "$p" >> "$MERGED"
        else
          printf '(allow file-read* file-write* (literal "%s"))\n' "$p" >> "$MERGED"
        fi
      done
      for p in "''${EXTRA_RO_ALLOW[@]}"; do
        if [ -d "$p" ]; then
          printf '(allow file-read* (subpath "%s"))\n' "$p" >> "$MERGED"
        else
          printf '(allow file-read* (literal "%s"))\n' "$p" >> "$MERGED"
        fi
      done
      for p in "''${EXTRA_DENY[@]}"; do
        if [ -d "$p" ]; then
          printf '(deny file-read* file-write* (subpath "%s"))\n' "$p" >> "$MERGED"
        else
          printf '(deny file-read* file-write* (literal "%s"))\n' "$p" >> "$MERGED"
        fi
      done

      if [ "$NO_NET" -eq 1 ]; then
        cat >> "$MERGED" <<'EOF'
    (deny network*)
    (allow network* (local ip))
    (allow network* (remote ip "localhost:*"))
    EOF
      fi
      PROFILE_FILE="$MERGED"
    fi

    # Env scrub. Common agent API keys forwarded if set.
    PASS_ENV=( ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY )
    PASS_ENV+=( "''${PASS_ENV_USER[@]}" )

    ENV_ARGS=()
    for v in "''${PASS_ENV[@]}"; do
      [ -n "''${!v:-}" ] && ENV_ARGS+=( "$v=''${!v}" )
    done
    ENV_ARGS+=(
      "HOME=$HOME"
      "USER=''${USER:-$(id -un)}"
      "PATH=$PATH"
      "TERM=''${TERM:-xterm}"
      "LANG=''${LANG:-en_US.UTF-8}"
      "SSL_CERT_FILE=''${SSL_CERT_FILE:-/etc/ssl/cert.pem}"
      "PWD=$PWD"
    )

    exec /usr/bin/env -i "''${ENV_ARGS[@]}" \
      /usr/bin/sandbox-exec \
        -D HOME="$HOME" \
        -D PWD="$PWD" \
        -f "$PROFILE_FILE" \
        -- "$@"
  '';
}
