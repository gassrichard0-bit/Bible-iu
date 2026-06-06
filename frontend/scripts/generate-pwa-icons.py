"""Generate placeholder PWA icons referenced by manifest.webmanifest.

Renders a simple monogram ("B") on the brand-cream background so the
manifest stops 404'ing in production. Replace with real artwork
before public launch — this is just the minimum viable shape.

Run from anywhere:
    python frontend/scripts/generate-pwa-icons.py
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


PUBLIC_DIR = Path(__file__).resolve().parent.parent / "public"


# Paper-cream background + neutral-900 mark — matches the app's
# default light-theme surface so iOS's home-screen icon looks like
# it belongs.
BG = (247, 243, 234)        # #f7f3ea — bg-paper-soft
FG = (23, 23, 23)           # #171717 — neutral-900


def _pick_font(target_px: int) -> ImageFont.ImageFont:
    """Try a few macOS / Linux fonts; fall back to PIL's default."""
    candidates = [
        "/System/Library/Fonts/SFNS.ttf",  # macOS SF
        "/System/Library/Fonts/Supplemental/Georgia.ttf",
        "/Library/Fonts/Georgia.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVu-Sans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, target_px)
        except (OSError, ValueError):
            continue
    return ImageFont.load_default()


def render(size: int, padded: bool = False, output: str = None) -> Path:
    img = Image.new("RGB", (size, size), BG)
    draw = ImageDraw.Draw(img)
    # Maskable icons need a safe zone — keep the glyph in the central
    # 80% so iOS / Android can crop without clipping.
    inner = int(size * 0.80) if padded else size
    glyph_px = int(inner * 0.62)
    font = _pick_font(glyph_px)
    # Center the glyph using the typographic bbox.
    bbox = draw.textbbox((0, 0), "B", font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    x = (size - w) // 2 - bbox[0]
    y = (size - h) // 2 - bbox[1]
    draw.text((x, y), "B", fill=FG, font=font)
    out = PUBLIC_DIR / (output or f"icon-{size}.png")
    img.save(out, "PNG", optimize=True)
    return out


def main() -> None:
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    written = [
        render(180, output="icon-180.png"),     # Apple touch icon
        render(192, output="icon-192.png"),     # PWA standard
        render(512, output="icon-512.png"),     # PWA hi-res
        render(512, padded=True, output="icon-maskable-512.png"),
    ]
    for p in written:
        print(f"wrote {p}")


if __name__ == "__main__":
    main()
