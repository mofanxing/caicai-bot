"""Animate the user-supplied Caicai illustration locally; no model/API calls.

Requires Pillow, NumPy and imageio-ffmpeg. Run from any working directory.
Keeps the original PNG intact and emits native VP9-alpha desktop-pet clips.
"""
from pathlib import Path
import math
import subprocess

import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent
W, H, FPS = 512, 768, 24
SOURCE = Image.open(ROOT / 'caicai-character.png').convert('RGBA')
SCALE = 480 / SOURCE.width
TAU = math.tau


def skin_patch(image, box):
    """Interpolate adjacent skin rows; feather the local expression overlay."""
    x0, y0, x1, y1 = box
    pixels = np.asarray(image)
    upper = pixels[y0 - 3, x0:x1].astype(float)
    lower = pixels[y1 + 3, x0:x1].astype(float)
    t = np.linspace(0, 1, y1 - y0)[:, None, None]
    patch = Image.fromarray(np.uint8(upper[None] * (1-t) + lower[None] * t))
    mask = Image.new('L', patch.size)
    ImageDraw.Draw(mask).rounded_rectangle((2, 2, patch.width-3, patch.height-3), radius=12, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(3))
    image.paste(patch, (x0, y0), mask)


def expression(blink=0, talk=0):
    image = SOURCE.copy()
    if blink > 0.02:
        for box in [(336, 526, 550, 689), (682, 511, 887, 669)]:
            x0, y0, x1, y1 = box
            eye = image.crop(box)
            skin_patch(image, box)
            height = max(3, round((y1-y0) * (1-blink)))
            cy = round((y0+y1)/2 + blink*13)
            if blink < .94:
                eye = eye.resize((x1-x0, height), Image.Resampling.LANCZOS)
                mask = Image.new('L', eye.size, 255)
                image.paste(eye, (x0, cy-height//2), mask)
            else:
                draw = ImageDraw.Draw(image)
                draw.arc((x0+19, cy-28, x1-15, cy+17), 7, 173, fill=(76, 43, 38, 255), width=6)
    if talk > .03:
        skin_patch(image, (565, 703, 671, 750))
        draw = ImageDraw.Draw(image)
        mouth_h = 5 + talk*27
        draw.ellipse((592, 722-mouth_h/2, 645, 722+mouth_h/2), fill=(112, 47, 49, 255), outline=(165, 76, 70, 255), width=2)
        if mouth_h > 13:
            draw.ellipse((602, 723+mouth_h*.08, 635, 722+mouth_h*.42), fill=(224, 133, 137, 255))
    canvas = Image.new('RGBA', (W, H))
    canvas.alpha_composite(image.resize((480, 720), Image.Resampling.LANCZOS), (16, 24))
    return canvas


def smooth(value):
    v = np.clip(value, 0, 1)
    return v*v*(3-2*v)


def frame(kind, t, duration):
    phase = TAU*t/duration
    blink = max(0, 1-abs(t-duration*.68)/.11)
    talk = 0
    angle = 0
    sway = 1.5*math.sin(phase)
    bounce = 0
    breath = 1.6*math.sin(phase)
    step = 0
    if kind == 'look':
        angle = 2.8*math.sin(phase)
        sway = 4*math.sin(phase)
    elif kind == 'happy':
        bounce = -13 * math.sin(phase*2)**2
        angle = 2.5*math.sin(phase*2)
        blink = .98*max(0, math.sin(phase))**6
    elif kind == 'talk':
        talk = max(0, math.sin(TAU*t*3.2))**.7*.85
        angle = 1.2*math.sin(phase*2)
    elif kind == 'think':
        angle = -4*math.sin(phase/2)**2
        sway = -3*math.sin(phase/2)**2
    elif kind == 'drag':
        angle = 5*math.sin(phase*2)
        bounce = -7*math.sin(phase)**2
    elif kind == 'step':
        step = math.sin(phase*4)
        angle = 1.1*step
        bounce = -3.5*step*step
    elif kind in ('sleep-in', 'sleep', 'wake'):
        sleep = float(smooth(t/duration)) if kind == 'sleep-in' else 1-float(smooth(t/duration)) if kind == 'wake' else 1
        blink = sleep
        angle = 5*sleep
        sway = 3*sleep
        breath *= .65
    image = expression(blink, talk)
    # Inverse mesh deformation fixes the feet while the torso and hair breathe.
    angle = math.radians(angle)
    def source_point(x, y):
        head = 1-float(smooth((y-300)/210))
        a = -angle*head
        dx, dy = x-256, y-360
        sx = 256 + dx*math.cos(a)-dy*math.sin(a)
        sy = 360 + dx*math.sin(a)+dy*math.cos(a)
        weight = float(smooth((744-y)/420))
        sx -= sway*weight
        sy -= breath*weight + bounce
        # A small, alternating leg lift rather than translating the entire cutout.
        leg = float(smooth((y-510)/150))
        side = math.tanh((x-256)/35)
        sy += leg * max(0, step*side)*5
        sx += leg * side*step*1.6
        return sx, sy
    mesh = []
    for y in range(0, H, 24):
        for x in range(0, W, 32):
            r, b = min(W, x+32), min(H, y+24)
            points = [source_point(x,y), source_point(x,b), source_point(r,b), source_point(r,y)]
            mesh.append(((x,y,r,b), tuple(v for point in points for v in point)))
    return image.transform((W,H), Image.Transform.MESH, mesh, Image.Resampling.BICUBIC)


CLIPS = {
    '待机呼吸': ('idle', 4), '轻轻张望': ('look', 4),
    '开心回应': ('happy', 2), '开口说话': ('talk', 4),
    '认真思考': ('think', 4), '悬空摇摆': ('drag', 2),
    '轻步移动': ('step', 3), '慢慢入睡': ('sleep-in', 2),
    '安静小憩': ('sleep', 4), '睡醒啦': ('wake', 2),
}


def main():
    output = ROOT / 'caicai-animation'
    output.mkdir(exist_ok=True)
    encoder = imageio_ffmpeg.get_ffmpeg_exe()
    for name, (kind, duration) in CLIPS.items():
        target = output / f'{name}.webm'
        temporary = target.with_suffix('.rendering.webm')
        command = [encoder, '-hide_banner', '-loglevel', 'error', '-y',
                   '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', f'{W}x{H}',
                   '-r', str(FPS), '-i', '-', '-an', '-c:v', 'libvpx-vp9',
                   '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '0',
                   '-crf', '28', '-deadline', 'good', '-cpu-used', '4',
                   '-metadata:s:v:0', 'alpha_mode=1', str(temporary)]
        process = subprocess.Popen(command, stdin=subprocess.PIPE)
        try:
            for n in range(round(FPS*duration)):
                process.stdin.write(frame(kind, n/FPS, duration).tobytes())
            process.stdin.close()
            if process.wait() != 0:
                raise RuntimeError(f'Failed to encode {name}')
            temporary.replace(target)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            temporary.unlink(missing_ok=True)
        print(f'{name}: {duration}s / {target.stat().st_size // 1024} KiB', flush=True)
    # A static expression sheet makes the small facial edits easy to inspect.
    sheet = Image.new('RGB', (W*3,H), '#f4f1ec')
    for i, args in enumerate([('idle', 0, 4), ('talk', .08, 4), ('sleep', 0, 4)]):
        image = frame(*args)
        sheet.paste(image, (i*W,0), image)
    sheet.resize((1024,512), Image.Resampling.LANCZOS).save(ROOT / 'caicai-preview.png')


if __name__ == '__main__':
    main()
