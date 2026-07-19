#!/usr/bin/env python3
"""Build the story runtime and serve the local state editor."""

from __future__ import annotations

import argparse
import functools
import http.server
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the local story state editor")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-open", action="store_true", help="do not open a browser")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    subprocess.run(
        [sys.executable, str(ROOT / "tools" / "story_harness.py"), "build"],
        cwd=ROOT,
        check=True,
    )

    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler,
        directory=str(ROOT),
    )
    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    url = f"http://127.0.0.1:{args.port}/editor/"
    print(f"Story editor: {url}")
    print("Press Ctrl+C to stop.")

    if not args.no_open:
        threading.Timer(0.35, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStory editor stopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
