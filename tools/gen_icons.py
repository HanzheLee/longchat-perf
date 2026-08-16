#!/usr/bin/env python3
"""生成扩展图标（纯标准库，无 PIL 依赖）。

设计：深蓝圆角方块 + 绿色闪电。输出到 chatgpt-perf/icons/。
用法：python3 tools/gen_icons.py
"""
import struct, zlib, os

OUT = os.path.join(os.path.dirname(__file__), "..", "icons")
SIZES = [16, 48, 128]

BG = (15, 23, 42)      # #0f172a 深蓝
BOLT = (34, 197, 94)   # #22c55e 绿
CORNER = 0.24          # 圆角半径比例


def in_rounded_rect(x, y, size):
    r = size * CORNER
    if r <= 0:
        return True
    x0, y0, x1, y1 = 0, 0, size, size
    if x < x0 or y < y0 or x >= x1 or y >= y1:
        return False
    def corner(cx, cy):
        return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
    if x < x0 + r and y < y0 + r:
        return corner(x0 + r, y0 + r)
    if x >= x1 - r and y < y0 + r:
        return corner(x1 - r, y0 + r)
    if x < x0 + r and y >= y1 - r:
        return corner(x0 + r, y1 - r)
    if x >= x1 - r and y >= y1 - r:
        return corner(x1 - r, y1 - r)
    return True


def in_bolt(x, y, size):
    """闪电多边形（点按顺时针/逆时针均可，射线法判断）。"""
    s = size
    pts = [
        (0.56 * s, 0.06 * s),
        (0.26 * s, 0.62 * s),
        (0.45 * s, 0.62 * s),
        (0.38 * s, 0.94 * s),
        (0.76 * s, 0.40 * s),
        (0.56 * s, 0.40 * s),
        (0.72 * s, 0.06 * s),
    ]
    inside = False
    j = len(pts) - 1
    for i in range(len(pts)):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def render(size):
    px = bytearray()
    for y in range(size):
        for x in range(size):
            if not in_rounded_rect(x, y, size):
                px += bytes(BG)  # 透明角改为背景色（简化，避免 alpha）
            elif in_bolt(x, y, size):
                px += bytes(BOLT)
            else:
                px += bytes(BG)
    return bytes(px)


def png_encode(raw, w, h):
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        c += struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        return c

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    rows = b"".join(b"\x00" + raw[y * w * 3:(y + 1) * w * 3] for y in range(h))
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")


def main():
    os.makedirs(OUT, exist_ok=True)
    for size in SIZES:
        raw = render(size)
        path = os.path.join(OUT, f"icon{size}.png")
        with open(path, "wb") as f:
            f.write(png_encode(raw, size, size))
        print("wrote", path, len(png_encode(raw, size, size)), "bytes")


if __name__ == "__main__":
    main()
