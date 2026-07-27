"""Render Narwal SPA scenes via headless Chromium.

Usage:
    /mnt/llm-shared/.venv/bin/python tools/screenshot.py <scene> [<scene> ...]

Waits for every `.overlay:not(.hidden)` spinner to disappear before
firing the screenshot, so scenes that fetch /api/* end up fully painted.
"""

from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parents[1] / "data" / "screenshots"
OUT.mkdir(parents=True, exist_ok=True)


def shoot(scenes: list[str]) -> None:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1400, "height": 900})
        for scene in scenes:
            url = f"http://127.0.0.1:8080/#{scene}"
            print(f"→ {url}")
            page.goto(url, wait_until="domcontentloaded", timeout=30_000)
            try:
                page.wait_for_function(
                    """() => Array.from(document.querySelectorAll('.overlay'))
                              .every((o) => o.classList.contains('hidden'))""",
                    timeout=60_000,
                )
            except Exception as exc:
                print(f"   ! spinner did not clear: {exc}")
            page.wait_for_timeout(400)  # paint margin
            out = OUT / f"{scene}.png"
            page.screenshot(path=str(out), full_page=True)
            print(f"   wrote {out}")
        browser.close()


if __name__ == "__main__":
    shoot(sys.argv[1:] or ["home"])
