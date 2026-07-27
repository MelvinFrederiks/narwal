"""Render the polar-bear mockup HTML files to PNG via headless Chromium.

Usage:
    /mnt/llm-shared/.venv/bin/python tools/screenshot_mockups.py
"""

from __future__ import annotations

from pathlib import Path
from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parents[1]
MOCK = REPO / "data" / "mockups"
OUT = REPO / "data" / "screenshots"
OUT.mkdir(parents=True, exist_ok=True)

PAGES = [
    ("polar-1-home.html",        "polar-1-home.png"),
    ("polar-2-verdict.html",     "polar-2-verdict.png"),
    ("polar-3-coverage.html",    "polar-3-coverage.png"),
    ("polar-unicorn-home.html",  "polar-unicorn-home.png"),
    ("polar-narwal-home.html",   "polar-narwal-home.png"),
    ("narwal-home.html",         "narwal-home.png"),
    ("narwal-home-2.html",       "narwal-home-2.png"),
    ("narwal-home-3.html",       "narwal-home-3.png"),
    ("narwal-home-4.html",       "narwal-home-4.png"),
    ("narwal-home-5.html",       "narwal-home-5.png"),
    ("narwal-home-6.html",       "narwal-home-6.png"),
]


def main() -> None:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1400, "height": 900})
        for src, dst in PAGES:
            url = f"file://{MOCK / src}"
            print(f"→ {url}")
            page.goto(url, wait_until="domcontentloaded", timeout=30_000)
            page.wait_for_timeout(400)
            out = OUT / dst
            page.screenshot(path=str(out), full_page=True)
            print(f"   wrote {out}")
        browser.close()


if __name__ == "__main__":
    main()
