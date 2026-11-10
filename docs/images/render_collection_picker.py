"""Rebuild the collection-picker illustration as editable SVG and 2x PNG.

Run with Python 3 and Pillow. Pass --font and --bold-font to use other CJK
fonts. The macOS STHeiti Light and Medium fonts reproduce the published PNG.
"""

import argparse
import os
from pathlib import Path
from xml.etree import ElementTree as ET

from PIL import Image, ImageDraw, ImageFont


WIDTH = 1080
HEIGHT = 398
SCALE = 2
BACKGROUND = "#f5f7f9"
TEXT = "#242b32"
BORDER = "#a4adb5"
ACCENT = "#3775a6"
SVG_NS = "http://www.w3.org/2000/svg"
FONT_STACK = "'Heiti SC', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif"


def find_font(bold):
    fonts_dir = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    choices = [
        Path("/System/Library/Fonts") / ("STHeiti Medium.ttc" if bold else "STHeiti Light.ttc"),
        fonts_dir / ("msyhbd.ttc" if bold else "msyh.ttc"),
        Path("/usr/share/fonts/opentype/noto")
        / ("NotoSansCJK-Bold.ttc" if bold else "NotoSansCJK-Regular.ttc"),
    ]
    return next((path for path in choices if path.is_file()), None)


class Illustration:
    def __init__(self, regular_font, bold_font):
        self.font_paths = {False: str(regular_font), True: str(bold_font)}
        self.fonts = {}
        self.bitmap = Image.new("RGB", (WIDTH * SCALE, HEIGHT * SCALE), BACKGROUND)
        self.canvas = ImageDraw.Draw(self.bitmap)
        self.svg = ET.Element("svg", {
            "xmlns": SVG_NS, "width": str(WIDTH), "height": str(HEIGHT),
            "viewBox": f"0 0 {WIDTH} {HEIGHT}", "role": "img",
            "aria-labelledby": "title desc", "xml:lang": "zh-CN",
        })
        ET.SubElement(self.svg, "title", id="title").text = "收藏引文时新建 Zotero 分类"
        ET.SubElement(self.svg, "desc", id="desc").text = (
            "操作示意。第一步选择数据选择分类，点击新建分类。"
            "第二步填写待读论文作为分类名称，点击新建并收藏。"
        )
        self.shape("rect", x=0, y=0, width=WIDTH, height=HEIGHT, fill=BACKGROUND)

    def shape(self, tag, **attributes):
        return ET.SubElement(self.svg, tag, {
            key.replace("_", "-"): str(value) for key, value in attributes.items()
        })

    def font(self, size, bold=False):
        key = (size, bold)
        if key not in self.fonts:
            self.fonts[key] = ImageFont.truetype(self.font_paths[bold], size * SCALE)
        return self.fonts[key]

    def text(self, x, y, value, size=15, color=TEXT, bold=False, centered=False):
        self.canvas.text(
            (x * SCALE, y * SCALE), value, font=self.font(size, bold), fill=color,
            anchor="mm" if centered else "lm",
        )
        node = self.shape(
            "text", x=x, y=y, fill=color, font_family=FONT_STACK, font_size=size,
            font_weight="600" if bold else "400",
            dominant_baseline="central", text_anchor="middle" if centered else "start",
        )
        node.text = value

    def box(self, x, y, width, height, radius, fill, stroke=None, line_width=1):
        self.canvas.rounded_rectangle(
            (x * SCALE, y * SCALE, (x + width) * SCALE, (y + height) * SCALE),
            radius=radius * SCALE, fill=fill, outline=stroke, width=line_width * SCALE,
        )
        self.shape(
            "rect", x=x, y=y, width=width, height=height, rx=radius,
            fill=fill or "none", stroke=stroke or "none", stroke_width=line_width,
        )

    def line(self, points, color, width=1):
        self.canvas.line([(x * SCALE, y * SCALE) for x, y in points], color, width=width * SCALE)
        self.shape("polyline", points=" ".join(f"{x},{y}" for x, y in points),
                   fill="none", stroke=color, stroke_width=width)

    def field(self, x, y, width, label, value, dropdown=True):
        self.text(x, y, label)
        self.box(x, y + 14, width, 32, 4, "#ffffff", BORDER)
        self.text(x + 10, y + 30, value)
        if dropdown:
            self.line([(x + width - 24, y + 28), (x + width - 19, y + 33),
                       (x + width - 14, y + 28)], "#414a51", 2)

    def button_width(self, label):
        return int(self.canvas.textlength(label, font=self.font(14)) / SCALE + 23)

    def button(self, x, y, label, highlight=False):
        width = self.button_width(label)
        self.box(x, y, width, 30, 4, "#f5f5f6", "#b6bbc0")
        self.text(x + 11, y + 15, label, 14)
        if highlight:
            self.box(x - 3, y - 3, width + 6, 36, 6, None, ACCENT, 2)

    def footer(self, x, y, width, action, highlight=False):
        start = x + width - self.button_width(action) - self.button_width("取消") - 8
        self.button(start, y, "取消")
        self.button(start + self.button_width("取消") + 8, y, action, highlight)

    def step(self, x, number, label):
        self.box(x, 22, 27, 27, 14, "#284f70")
        self.text(x + 13.5, 35, str(number), 15, "#ffffff", bold=True, centered=True)
        self.text(x + 38, 35, label, 19, bold=True)

    def dialog(self, x, y, width, height):
        self.box(x + 1, y + 3, width, height, 10, "#e0e4e7")
        self.box(x, y, width, height, 10, "#ffffff", "#acb4bc")
        self.text(x + 18, y + 24, "收藏到分类", 17, bold=True)

    def render(self, directory):
        left, right, width = 24, 552, 504
        self.step(left, 1, "选择目标分类，点击「新建分类…」")
        self.step(right, 2, "填写分类名称，点击「新建并收藏」")
        self.dialog(left, 66, width, 222)
        self.field(left + 18, 122, width - 36, "目标分类", "数据选择")
        self.button(left + 18, 183, "新建分类…", True)
        self.footer(left + 18, 242, width - 36, "收藏到此分类")
        self.dialog(right, 66, width, 278)
        self.field(right + 18, 122, width - 36, "上级分类", "数据选择")
        self.field(right + 18, 189, width - 36, "分类名称", "待读论文", dropdown=False)
        self.button(right + 18, 251, "返回已有分类")
        self.footer(right + 18, 297, width - 36, "新建并收藏", True)
        self.line([(24, 365), (1056, 365)], "#c9d0d6")
        self.text(24, 383, "操作示意 · 示例结果为「数据选择 / 待读论文」", 14, "#4b5966")
        directory.mkdir(parents=True, exist_ok=True)
        self.bitmap.save(directory / "collection-picker.png", optimize=True)
        ET.indent(self.svg)
        ET.ElementTree(self.svg).write(directory / "collection-picker.svg",
                                       encoding="utf-8", xml_declaration=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--font", type=Path, default=find_font(False))
    parser.add_argument("--bold-font", type=Path, default=find_font(True))
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    if not args.font or not args.bold_font:
        parser.error("Provide Chinese-capable font files using --font and --bold-font.")
    Illustration(args.font, args.bold_font).render(args.output_dir)
