from __future__ import annotations

import fnmatch
import os
import subprocess
import sys
import tomllib
from pathlib import Path


def root_path() -> Path:
    env_root = os.environ.get("FLOW_ROOT")
    if env_root:
        return Path(env_root).resolve()
    for path in Path(__file__).resolve().parents:
        if (path / "flow.toml").exists():
            return path
    raise SystemExit("Unable to locate FARMserver root; set FLOW_ROOT.")


def load_branch_policy() -> tuple[list[str], list[str], list[str]]:
    raw = tomllib.loads((root_path() / "flow.toml").read_text())
    gates = raw.get("gates") or {}
    protected = list(gates.get("protected_branch_patterns") or [])
    allowed = list(gates.get("allowed_branch_patterns") or [])
    overrides = list(gates.get("allowed_branch_overrides") or [])
    if not allowed:
        allowed = [
            f"{str(prefix).strip('/')}/*"
            for prefix in gates.get("allowed_branch_prefixes") or []
            if str(prefix).strip("/")
        ]
    return protected, allowed, overrides


def real_git() -> str:
    return os.environ.get("FLOW_REAL_GIT") or "/usr/bin/git"


def real_gh() -> str:
    return os.environ.get("FLOW_REAL_GH") or "/opt/homebrew/bin/gh"


def current_branch() -> str:
    result = subprocess.run(
        [real_git(), "rev-parse", "--abbrev-ref", "HEAD"],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout.strip()


def is_protected(branch: str) -> bool:
    protected, _allowed, _overrides = load_branch_policy()
    return any(fnmatch.fnmatch(branch, pattern) for pattern in protected)


def is_allowed(branch: str) -> bool:
    _protected, allowed, overrides = load_branch_policy()
    return any(fnmatch.fnmatch(branch, pattern) for pattern in [*allowed, *overrides])


def ensure_safe_branch(branch: str, *, context: str) -> None:
    if not branch or branch == "HEAD":
        raise SystemExit(f"Blocked {context}: unable to resolve a safe branch.")
    if is_protected(branch):
        raise SystemExit(f"Blocked {context}: protected branch `{branch}`.")
    if not is_allowed(branch):
        raise SystemExit(f"Blocked {context}: branch `{branch}` is not explicitly allowed.")


def first_non_option(args: list[str]) -> str | None:
    for arg in args:
        if arg == "--":
            break
        if not arg.startswith("-"):
            return arg
    return None


def created_branch_arg(args: list[str]) -> str | None:
    for flag in ("-b", "-B", "-c", "-C"):
        if flag in args:
            idx = args.index(flag)
            if idx + 1 < len(args):
                return args[idx + 1]
    return None


def git_guard(argv: list[str]) -> None:
    if not argv:
        os.execv(real_git(), [real_git()])
    subcommand = argv[0]

    if subcommand == "commit":
        ensure_safe_branch(current_branch(), context="git commit")
    elif subcommand == "push":
        ensure_safe_branch(current_branch(), context="git push")
        refs = [arg for arg in argv[1:] if not arg.startswith("-")]
        for refspec in refs[1:]:
            target = refspec.split(":", 1)[-1] if ":" in refspec else refspec
            if target and not target.startswith("refs/"):
                ensure_safe_branch(target, context="git push target")
    elif subcommand in {"checkout", "switch"}:
        new_branch = created_branch_arg(argv[1:])
        if new_branch:
            ensure_safe_branch(new_branch, context=f"git {subcommand}")
        elif "--detach" not in argv[1:]:
            target = first_non_option(argv[1:])
            if target and not target.startswith("refs/") and is_protected(target):
                raise SystemExit(f"Blocked git {subcommand}: protected branch `{target}`.")
    elif subcommand == "branch":
        args = argv[1:]
        if "-m" in args or "-M" in args:
            flag = "-m" if "-m" in args else "-M"
            idx = args.index(flag)
            if idx + 1 < len(args):
                ensure_safe_branch(args[idx + 1], context="git branch rename")
        else:
            target = first_non_option(args)
            if target and target not in {"-d", "-D", "--list"}:
                ensure_safe_branch(target, context="git branch create")

    os.execv(real_git(), [real_git(), *argv])


def gh_guard(argv: list[str]) -> None:
    if len(argv) >= 2 and argv[0] == "pr" and argv[1] == "merge":
        raise SystemExit("Blocked gh pr merge: human merge authority is mandatory.")
    os.execv(real_gh(), [real_gh(), *argv])


def pre_push_guard() -> None:
    for line in sys.stdin:
        parts = line.strip().split()
        if len(parts) != 4:
            continue
        remote_ref = parts[2]
        if remote_ref.startswith("refs/heads/"):
            branch = remote_ref.removeprefix("refs/heads/")
            ensure_safe_branch(branch, context="pre-push")


def reference_transaction_guard(argv: list[str]) -> None:
    stage = argv[0] if argv else ""
    if stage and stage != "prepared":
        return
    for line in sys.stdin:
        parts = line.strip().split()
        if len(parts) != 3:
            continue
        ref_name = parts[2]
        if ref_name.startswith("refs/heads/"):
            branch = ref_name.removeprefix("refs/heads/")
            ensure_safe_branch(branch, context="reference update")


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: flow-guard.py <git|gh|hook-pre-push|hook-reference-transaction> ...")
    mode = sys.argv[1]
    argv = sys.argv[2:]
    if mode == "git":
        git_guard(argv)
    if mode == "gh":
        gh_guard(argv)
    if mode == "hook-pre-push":
        pre_push_guard()
        return
    if mode == "hook-reference-transaction":
        reference_transaction_guard(argv)
        return
    raise SystemExit(f"unknown mode: {mode}")


if __name__ == "__main__":
    main()
