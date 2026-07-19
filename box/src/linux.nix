{ pkgs }:

# Linux mechanism: bubblewrap user-namespace sandbox.
#
# Profile-driven policy — see `--profile=NAME`. Each built-in profile sets
# the variables consumed below: BIND_HOME, HIDE_DIRS, HIDE_FILES, SHARE_NET,
# PASS_ENV. CLI flags layer on top of the profile (--allow extends bind set,
# --deny extends hide set, --env extends passthrough, --no-net forces drop).
#
# The bwrap FLAGS assembled here are the security boundary, not this script.

pkgs.writeShellApplication {
  name = "pagu-box";
  runtimeInputs = [ pkgs.bubblewrap ];
  text = ''
    set -euo pipefail

    PROFILE="default"
    EXTRA_ALLOW=()
    EXTRA_RO_ALLOW=()
    EXTRA_DENY=()
    PASS_ENV_USER=()
    NO_NET=0
    AGENT_PRESETS=()      # --claude, --opencode, --codex, --aider etc.
    AUTO_AGENT=1          # set 0 with --no-auto-agent to suppress command-name inference
    PWD_RO=0              # downgrade $PWD bind from RW to RO; per-deployment wrappers
                          # use this to keep a tree read-only without rewriting the bind set
    NEEDS_JOURNAL=0       # opt in to read-only journalctl access (journal dirs + machine-id)

    while [ $# -gt 0 ]; do
      case "$1" in
        --profile=*)    PROFILE="''${1#--profile=}"; shift ;;
        --profile)      PROFILE="$2"; shift 2 ;;
        --allow)        EXTRA_ALLOW+=("$2"); shift 2 ;;
        --ro-allow)     EXTRA_RO_ALLOW+=("$2"); shift 2 ;;
        --deny)         EXTRA_DENY+=("$2"); shift 2 ;;
        --env)          PASS_ENV_USER+=("''${2%%=*}"); shift 2 ;;
        --no-net)       NO_NET=1; shift ;;
        # Agent presets — add the state binds the named agent CLI needs
        # to function. Repeatable. Stackable with the auto-inference
        # below (sandbox a multi-agent pipeline by passing more than one).
        --claude)       AGENT_PRESETS+=(claude); shift ;;
        --opencode)     AGENT_PRESETS+=(opencode); shift ;;
        --codex)        AGENT_PRESETS+=(codex); shift ;;
        --aider)        AGENT_PRESETS+=(aider); shift ;;
        --pi)           AGENT_PRESETS+=(pi); shift ;;
        --hermes)       AGENT_PRESETS+=(hermes); shift ;;
        --agent)        AGENT_PRESETS+=("$2"); shift 2 ;;
        --no-auto-agent) AUTO_AGENT=0; shift ;;
        --pwd-ro)       PWD_RO=1; shift ;;
        --journal)      NEEDS_JOURNAL=1; shift ;;
        --)             shift; break ;;
        -h|--help)
          cat <<'USAGE'
    pagu-box [OPTIONS] -- COMMAND [ARGS...]
    pagu-box [OPTIONS] COMMAND [ARGS...]

      --profile=NAME    default | strict | paranoid | loose  (default: default)
      --allow PATH      extra read-write bind mount (repeatable)
      --ro-allow PATH   extra read-only bind mount (repeatable)
      --deny PATH       extra deny — tmpfs over dir or /dev/null over file (repeatable)
      --env VAR         forward env var through the scrub (repeatable)
      --no-net          drop network access
      --claude          allow ~/.claude + ~/.claude.json (Claude Code state)
      --opencode        allow ~/.config/opencode + ~/.local/share/opencode + ~/.cache/opencode
      --codex           allow ~/.codex (OpenAI Codex CLI state)
      --aider           allow ~/.aider.conf.yml + ~/.aider/ (aider state)
      --pi              allow ~/.pi/ (Pi coding agent state, github:badlogic/pi-mono)
      --hermes          allow ~/.hermes/ (Hermes Agent state, github:NousResearch/hermes-agent).
                        INTENTIONALLY excludes ~/.config/gh + GH_TOKEN — Hermes is
                        a self-improving agent with persistent memory; giving it
                        push/PR capability is out of scope. To layer agents that
                        need GH (e.g. claude-code), pass them as separate runs.
      --agent NAME      same as --<NAME> for an arbitrary registered preset
      --no-auto-agent   suppress auto-detection of the agent from the command name
      --pwd-ro          bind $PWD read-only instead of read-write (general primitive;
                        deployment wrappers compose this with their own policy)
      --journal         read-only systemd journal access (binds /var/log/journal,
                        /run/log/journal, /etc/machine-id). Auto-enabled when the
                        command is `journalctl`. Off by default — least-privilege
                        unless the agent is actually debugging the host.
      -h, --help        this text

    Profiles (this OS — Linux/bwrap):
      default     $HOME bound RW; secrets denied;        net allowed
      strict      $HOME tmpfs; only $PWD bound;          net allowed
      paranoid    $HOME tmpfs; only $PWD bound;          net DENIED
      loose       $HOME bound RW; only ~/.ssh, ~/.gnupg denied; net allowed

    Agent state binds are NOT part of the profile any more. Pass --<agent>
    (or rely on auto-detection from the command name) to opt in.
    USAGE
          exit 0 ;;
        *)              break ;;
      esac
    done
    [ $# -eq 0 ] && { echo "pagu-box: no command given" >&2; exit 64; }

    # Auto-infer agent from command name unless suppressed. Matches the
    # command being executed (first non-flag arg after `--`), not arbitrary
    # paths — so `pagu-box claude` infers --claude but `pagu-box vim` does not.
    if [ "$AUTO_AGENT" -eq 1 ]; then
      cmd_basename="$(basename "''${1:-}")"
      case "$cmd_basename" in
        claude|claude-code)  AGENT_PRESETS+=(claude) ;;
        opencode)            AGENT_PRESETS+=(opencode) ;;
        codex)               AGENT_PRESETS+=(codex) ;;
        aider)               AGENT_PRESETS+=(aider) ;;
        pi)                  AGENT_PRESETS+=(pi) ;;
        hermes)              AGENT_PRESETS+=(hermes) ;;
        journalctl)          NEEDS_JOURNAL=1 ;;
      esac
    fi

    # Expand each preset into the right --allow/--ro-allow set.
    for preset in "''${AGENT_PRESETS[@]}"; do
      case "$preset" in
        claude)
          EXTRA_ALLOW+=("$HOME/.claude" "$HOME/.claude.json")
          ;;
        opencode)
          EXTRA_ALLOW+=(
            "$HOME/.config/opencode"
            "$HOME/.local/share/opencode"
            "$HOME/.cache/opencode"
          )
          ;;
        codex)
          EXTRA_ALLOW+=("$HOME/.codex")
          ;;
        aider)
          EXTRA_ALLOW+=("$HOME/.aider.conf.yml" "$HOME/.aider")
          ;;
        pi)
          EXTRA_ALLOW+=("$HOME/.pi")
          ;;
        hermes)
          # ~/.hermes holds the SQLite session DB, MEMORY.md, skills,
          # and the bundled-uv/python/node runtime the installer dropped
          # in. The single dir is the whole footprint.
          # No GH state bound — git push / PR-open is intentionally
          # out of reach for this agent (operator runs claude-code for
          # that). See preset table in --help for why.
          EXTRA_ALLOW+=("$HOME/.hermes")
          ;;
        *)
          echo "pagu-box: unknown agent preset '$preset' — try claude|opencode|codex|aider|pi|hermes" >&2
          exit 64
          ;;
      esac
    done

    # journalctl needs the journal dirs AND /etc/machine-id (libsystemd looks
    # there to pick which host's journal to read). Without machine-id the
    # journal dirs alone produce "No journal files were found".
    if [ "$NEEDS_JOURNAL" -eq 1 ]; then
      EXTRA_RO_ALLOW+=(
        /var/log/journal
        /run/log/journal
        /etc/machine-id
      )
    fi

    # ---- profile selection ----
    case "$PROFILE" in
      default)
        BIND_HOME=1
        HIDE_DIRS=(
          "$HOME/.ssh"            "$HOME/.gnupg"
          "$HOME/.aws"            "$HOME/.azure"
          "$HOME/.config/sops"    "$HOME/.config/age"
          "$HOME/.config/gh"      "$HOME/.config/op"
          "$HOME/.config/gcloud"
          "$HOME/.password-store"
        )
        HIDE_FILES=(
          "$HOME/.netrc"          "$HOME/.bash_history"
          "$HOME/.zsh_history"    "$HOME/.python_history"
        )
        SHARE_NET=1
        ;;
      strict)
        BIND_HOME=0
        # No agent state binds by default — pass --<agent> (or let the
        # auto-detector match the command name) to opt in. This used to
        # hardcode ~/.claude{,.json} which was wrong for non-Claude runs.
        HIDE_DIRS=()
        HIDE_FILES=()
        SHARE_NET=1
        ;;
      paranoid)
        BIND_HOME=0
        HIDE_DIRS=()
        HIDE_FILES=()
        SHARE_NET=0
        ;;
      loose)
        BIND_HOME=1
        HIDE_DIRS=( "$HOME/.ssh" "$HOME/.gnupg" )
        HIDE_FILES=()
        SHARE_NET=1
        ;;
      *)
        echo "pagu-box: unknown profile '$PROFILE' (try default|strict|paranoid|loose)" >&2
        exit 64
        ;;
    esac

    # CLI override
    [ "$NO_NET" -eq 1 ] && SHARE_NET=0

    # ---- env passthrough policy ----
    # Common agent API keys are forwarded by default if present in the host env.
    PASS_ENV=( ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY )
    PASS_ENV+=( "''${PASS_ENV_USER[@]}" )

    # ---- assemble bwrap args ----
    args=(
      --ro-bind /nix/store /nix/store
      --bind /nix/var/nix/daemon-socket /nix/var/nix/daemon-socket
      --ro-bind-try /run/current-system /run/current-system
      --ro-bind-try /etc/static /etc/static
      --ro-bind-try /etc/profiles /etc/profiles
      --ro-bind-try /etc/nix /etc/nix
      --ro-bind-try /etc/resolv.conf /etc/resolv.conf
      --ro-bind-try /etc/nsswitch.conf /etc/nsswitch.conf
      --ro-bind-try /etc/hosts /etc/hosts
      --ro-bind-try /etc/ssl /etc/ssl
      --ro-bind-try /etc/passwd /etc/passwd
      --ro-bind-try /etc/group /etc/group
      --ro-bind-try /bin /bin
      --ro-bind-try /usr/bin /usr/bin
      --proc /proc
      --dev /dev
      --tmpfs /tmp
      --clearenv
    )

    # HOME — bind or tmpfs per profile.
    if [ "$BIND_HOME" -eq 1 ]; then
      args+=( --bind "$HOME" "$HOME" )
    else
      args+=( --tmpfs "$HOME" )
    fi

    # Working directory always available (mounted AFTER tmpfs HOME so it wins).
    # --pwd-ro is the policy primitive: pagu-box itself doesn't know which
    # trees are "sensitive"; that's the deployment wrapper's call (e.g. a
    # homelab-aware `box` wrapper that sets --pwd-ro when $PWD lives under
    # the operator's config repo).
    if [ "$PWD_RO" -eq 1 ]; then
      args+=( --ro-bind "$PWD" "$PWD" --chdir "$PWD" )
    else
      args+=( --bind "$PWD" "$PWD" --chdir "$PWD" )
    fi

    # Hide secrets (profile + --deny).
    for d in "''${HIDE_DIRS[@]}" "''${EXTRA_DENY[@]}"; do
      if [ -d "$d" ]; then
        args+=( --tmpfs "$d" )
      elif [ -f "$d" ]; then
        args+=( --bind /dev/null "$d" )
      fi
    done
    for f in "''${HIDE_FILES[@]}"; do
      [ -e "$f" ] && args+=( --bind /dev/null "$f" )
    done

    # Extra allowed paths.
    for p in "''${EXTRA_ALLOW[@]}"; do
      [ -e "$p" ] && args+=( --bind "$p" "$p" )
    done
    for p in "''${EXTRA_RO_ALLOW[@]}"; do
      [ -e "$p" ] && args+=( --ro-bind "$p" "$p" )
    done

    # Env passthrough.
    for v in "''${PASS_ENV[@]}"; do
      [ -n "''${!v:-}" ] && args+=( --setenv "$v" "''${!v}" )
    done
    args+=(
      --setenv HOME "$HOME"
      --setenv USER "''${USER:-$(id -un)}"
      --setenv PATH "$PATH"
      --setenv TERM "''${TERM:-xterm}"
      --setenv LANG "''${LANG:-C.UTF-8}"
      --setenv NIX_REMOTE daemon
      --setenv SSL_CERT_FILE "''${SSL_CERT_FILE:-''${NIX_SSL_CERT_FILE:-/etc/ssl/certs/ca-certificates.crt}}"
    )

    # Isolation.
    args+=( --unshare-all --die-with-parent )
    [ "$SHARE_NET" -eq 1 ] && args+=( --share-net )

    exec ${pkgs.bubblewrap}/bin/bwrap "''${args[@]}" -- "$@"
  '';
}
