# scripts/pwa_icons.py — draws the installed app's icon (a small woven square) as PNGs at the
# sizes browsers ask an installable page for. Run: python3 scripts/pwa_icons.py
from pathlib import Path

from PIL import Image, ImageDraw


class WovenIcon:
    """A dark square with three warp and three weft bands crossing over and under,
    like a few threads of a weave: generic, and readable at home-screen sizes."""

    BACKGROUND = (22, 27, 34)
    WARP = (233, 196, 106)   # the vertical threads
    WEFT = (125, 211, 192)   # the horizontal threads
    BANDS = 3

    def __init__(self, size):
        self.size = size

    def draw(self):
        image = Image.new('RGB', (self.size, self.size), WovenIcon.BACKGROUND)
        canvas = ImageDraw.Draw(image)
        margin = self.size * 0.16
        span = self.size - 2 * margin
        pitch = span / WovenIcon.BANDS
        width = pitch * 0.62

        # Each crossing shows the thread on top: warp over weft where row + column is even.
        for row in range(WovenIcon.BANDS):
            for column in range(WovenIcon.BANDS):
                center_x = margin + pitch * (column + 0.5)
                center_y = margin + pitch * (row + 0.5)
                weft = [margin, center_y - width / 2, margin + span, center_y + width / 2]
                warp = [center_x - width / 2, margin, center_x + width / 2, margin + span]
                canvas.rectangle(weft, fill=WovenIcon.WEFT)
                canvas.rectangle(warp, fill=WovenIcon.WARP)
        for row in range(WovenIcon.BANDS):
            for column in range(WovenIcon.BANDS):
                if (row + column) % 2:
                    center_x = margin + pitch * (column + 0.5)
                    center_y = margin + pitch * (row + 0.5)
                    canvas.rectangle([center_x - width / 2, center_y - width / 2, center_x + width / 2, center_y + width / 2], fill=WovenIcon.WEFT)
        return image


class IconSet:
    """Writes the icon at each size into apps/browser/pwa."""

    SIZES = [192, 512]

    def __init__(self, directory):
        self.directory = Path(directory)

    def run(self):
        for size in IconSet.SIZES:
            path = self.directory / f'icon-{size}.png'
            WovenIcon(size).draw().save(path, optimize=True)
            print(f'wrote {path}')


if __name__ == '__main__':
    IconSet(Path(__file__).resolve().parent.parent / 'apps' / 'browser' / 'pwa').run()
