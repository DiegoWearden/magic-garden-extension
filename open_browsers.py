import os
import sys
import shutil
import subprocess
import tempfile
import platform
import signal
import time
from pathlib import Path
from typing import List, Tuple

URL = "https://magiccircle.gg/r/JC66"
NUM_WINDOWS = 6

# --- Platform helpers ---------------------------------------------------------

IS_WINDOWS = platform.system() == "Windows"
IS_DARWIN = platform.system() == "Darwin"

def candidates_by_os() -> List[Tuple[str, str]]:
    system = platform.system()

    if system == "Windows":
        program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
        program_files_x86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
        local_appdata = os.environ.get("LOCALAPPDATA", r"C:\Users\%USERNAME%\AppData\Local")

        return [
            ("Google Chrome", str(Path(program_files, "Google", "Chrome", "Application", "chrome.exe"))),
            ("Microsoft Edge", str(Path(program_files_x86, "Microsoft", "Edge", "Application", "msedge.exe"))),
            ("Brave", str(Path(program_files, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"))),
            ("Vivaldi", str(Path(program_files, "Vivaldi", "Application", "vivaldi.exe"))),
            ("Opera", str(Path(program_files, "Opera", "launcher.exe"))),
            ("Chromium", "chromium.exe"),
            ("Chrome (User Local)", str(Path(local_appdata, "Google", "Chrome", "Application", "chrome.exe"))),
        ]

    if system == "Darwin":  # macOS
        return [
            ("Google Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            ("Microsoft Edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
            ("Brave", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"),
            ("Vivaldi", "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi"),
            ("Opera", "/Applications/Opera.app/Contents/MacOS/Opera"),
            ("Chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium"),
            ("google-chrome", "google-chrome"),
            ("chromium", "chromium"),
            ("chromium-browser", "chromium-browser"),
            ("brave-browser", "brave-browser"),
            ("vivaldi", "vivaldi"),
            ("opera", "opera"),
        ]

    # Linux / other Unix
    return [
        ("google-chrome", "google-chrome"),
        ("google-chrome-stable", "google-chrome-stable"),
        ("chromium", "chromium"),
        ("chromium-browser", "chromium-browser"),
        ("brave-browser", "brave-browser"),
        ("vivaldi", "vivaldi"),
        ("opera", "opera"),
        ("microsoft-edge", "microsoft-edge"),
        ("msedge", "msedge"),
    ]

def resolve_executable(path_or_name: str):
    p = Path(path_or_name)
    if p.exists():
        return str(p)
    found = shutil.which(path_or_name)
    return found

def find_installed_browsers() -> List[Tuple[str, str]]:
    found = []
    seen_paths = set()
    for label, entry in candidates_by_os():
        exe = resolve_executable(entry)
        if exe and exe not in seen_paths:
            seen_paths.add(exe)
            found.append((label, exe))
    return found

# --- Browser Manager ----------------------------------------------------------

class BrowserManager:
    def __init__(self):
        self.processes: List[subprocess.Popen] = []
        self.temp_profiles: List[str] = []
        self.cleaned = False

        # ensure cleanup on exit / signals
        import atexit
        atexit.register(self.cleanup)
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, self._signal_handler)

    def _signal_handler(self, signum, frame):
        # best-effort graceful shutdown, then hard kill
        self.cleanup()
        # re-raise default to exit immediately
        signal.signal(signum, signal.SIG_DFL)
        os.kill(os.getpid(), signum)

    def launch(self, exe: str, url: str, profile_dir: str | None = None) -> bool:
        args = [exe, "--new-window", "--no-first-run", "--no-default-browser-check", url]
        if profile_dir:
            args.insert(1, "--user-data-dir=" + profile_dir)

        creationflags = 0
        startupinfo = None
        preexec_fn = None

        if IS_WINDOWS:
            # Hide console window and allow tree control via taskkill
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            # Note: we don't rely on CTRL_BREAK; taskkill /T handles the tree.
        else:
            # Put child in its own session so we can kill the whole process group.
            preexec_fn = os.setsid

        try:
            proc = subprocess.Popen(
                args,
                creationflags=creationflags,
                startupinfo=startupinfo,
                preexec_fn=preexec_fn,
            )
            self.processes.append(proc)
            return True
        except Exception as e:
            print(f"Failed to launch {exe}: {e}")
            return False

    def track_temp_profile(self, path: str):
        self.temp_profiles.append(path)

    def _terminate_proc_tree(self, proc: subprocess.Popen, timeout: float = 5.0):
        if proc.poll() is not None:
            return  # already exited

        try:
            if IS_WINDOWS:
                # Kill the entire tree: /T follows child processes; /F forces.
                subprocess.run(
                    ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            else:
                # Send SIGTERM to the whole process group.
                try:
                    pgid = os.getpgid(proc.pid)
                    os.killpg(pgid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                # Wait briefly, then SIGKILL if needed.
                t0 = time.time()
                while proc.poll() is None and (time.time() - t0) < timeout:
                    time.sleep(0.1)
                if proc.poll() is None:
                    try:
                        pgid = os.getpgid(proc.pid)
                        os.killpg(pgid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
        except Exception as e:
            print(f"Warning: failed to fully terminate PID {proc.pid}: {e}")

    def cleanup(self):
        if self.cleaned:
            return
        self.cleaned = True

        # Close all browsers we launched
        for proc in self.processes:
            self._terminate_proc_tree(proc)

        # Remove temp profiles
        for p in self.temp_profiles:
            try:
                shutil.rmtree(p, ignore_errors=True)
            except Exception as e:
                print(f"Warning: failed to remove temp profile {p}: {e}")

# --- Launch logic -------------------------------------------------------------

def launch_browser(exe: str, url: str, profile_dir: str | None, manager: BrowserManager) -> bool:
    ok = manager.launch(exe, url, profile_dir)
    return ok

def main():
    browsers = find_installed_browsers()
    if not browsers:
        print("No Chromium-based browsers were found on this system.")
        print("Install Chrome/Chromium/Brave/Edge/Vivaldi/Opera, or add them to PATH.")
        sys.exit(1)

    manager = BrowserManager()
    launched = 0

    # First, try one window per different browser executable
    for label, exe in browsers:
        if launched >= NUM_WINDOWS:
            break
        ok = launch_browser(exe, URL, None, manager)
        if ok:
            launched += 1

    # If we don't have enough different browsers, open extra instances
    while launched < NUM_WINDOWS and browsers:
        exe = browsers[0][1]
        temp_profile = tempfile.mkdtemp(prefix="chromium_profile_")
        manager.track_temp_profile(temp_profile)
        ok = launch_browser(exe, URL, temp_profile, manager)
        if ok:
            launched += 1
        else:
            print(f"Could not spawn additional instance with {exe}.")
            break

    print(f"Launched {launched} Chromium window(s) to {URL}.")
    print("Press Ctrl+C to stop and close all browsers.")

    # Block until all child browsers exit (or user kills the script)
    try:
        while any(p.poll() is None for p in manager.processes):
            time.sleep(0.5)
    finally:
        # Cleanup will run via atexit/signal handler, but call explicitly too.
        manager.cleanup()

if __name__ == "__main__":
    main()

