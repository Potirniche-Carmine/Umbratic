#!/usr/bin/env python3
"""Remove the local Console installation; retain models and desktop data."""

import datetime
import fcntl
import os
from pathlib import Path
import pwd
import subprocess
import sys
import time


def run(*args):
    return subprocess.run(args, check=True, stdout=subprocess.DEVNULL)


def main():
    if sys.platform != "darwin" or os.geteuid() != 0:
        raise SystemExit("Run sudo python3 scripts/reset-veil-console-macos.py on the Mac.")
    user = os.environ.get("SUDO_USER", "")
    if not user or user == "root":
        raise SystemExit("Run from your own account with sudo so the backup goes in your Trash.")
    account = pwd.getpwnam(user)
    home = Path(account.pw_dir)
    console = Path("/Library/Application Support/Umbratic/Veil Console")
    former = Path("/opt/umbratic")
    for root in (console, former):
        if root.is_symlink():
            raise SystemExit("Installation root is a symlink; no changes made.")

    locks = []
    for lock_path in (console / "Program.deploy-lock", former / "veil-console.deploy-lock"):
        if lock_path.parent.exists():
            lock = lock_path.open("a+")
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise SystemExit("A deployment is running; let it finish before resetting.")
            locks.append(lock)

    print("Stopping Veil Console and its model services...", flush=True)
    for name in ("console", "qdrant"):
        label = "system/com.umbratic." + name
        active = subprocess.run(["/bin/launchctl", "print", label], capture_output=True)
        if active.returncode == 0:
            run("/bin/launchctl", "bootout", label)

    prefixes = (str(console / "Program") + "/", "/opt/umbratic/veil-console/")
    for attempt in range(30):
        commands = subprocess.check_output(["/bin/ps", "-axo", "comm="], text=True)
        if not any(line.strip().startswith(prefixes) for line in commands.splitlines()):
            break
        time.sleep(1)
    else:
        raise SystemExit("An installed server process is still stopping; files were not removed. Rerun when it exits.")

    launcher = console / "Program/Models.app"
    if launcher.exists():
        run("/usr/bin/sudo", "-u", user,
            "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
            "-u", str(launcher))

    trash = home / ".Trash"
    trash.mkdir(mode=0o700, exist_ok=True)
    backup = trash / ("Veil Console reset " + datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
    backup.mkdir(mode=0o700)
    os.chown(backup, account.pw_uid, account.pw_gid)

    candidates = [
        (console / name, name)
        for name in ("Program", "State", "Backups")
    ]
    candidates += [
        (Path("/Library/LaunchDaemons/com.umbratic." + name + ".plist"), name + ".plist")
        for name in ("console", "qdrant")
    ]
    candidates += [
        (former, "former-opt-installation"),
        (Path("/private/var/lib/veil-console"), "former-state"),
        (home / "Library/Application Support/Umbratic/Veil Console", "development-console"),
    ]
    temp = Path(subprocess.check_output(
        ["/usr/bin/sudo", "-u", user, "/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"], text=True
    ).strip())
    temporary_names = ("umbratic-ui-test-state", "umbratic-ui-test-console.log", "umbratic-release-entitlement-check")
    candidates += [(temp / name, name) for name in temporary_names]
    # Move the held lock last: another deploy must not create a new lock inode
    # until all service files and active state have been removed.
    candidates.append((console / "Program.deploy-lock", "Program.deploy-lock"))
    moved = 0
    for source, name in candidates:
        if source.exists() or source.is_symlink():
            source.rename(backup / name)
            moved += 1
    for lock in locks:
        lock.close()
    print("Removed Console services and reset its installation.")
    print("Model files retained at:", console / "Models")
    print("Desktop data was not changed.")
    print("Recoverable previous installation:", backup)
    print("Archived items:", moved)


if __name__ == "__main__":
    main()
