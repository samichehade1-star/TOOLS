// One-off asset build: rasterizes the SVG marks into the PNG/ICO files the
// app actually loads at runtime (assets/logo.png, build/icon.ico). Not
// needed after that — sharp/png-to-ico are devDependencies purely for this.
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const pngToIco = require('png-to-ico').default;

const root = path.join(__dirname, '..');
const assetsDir = path.join(root, 'assets');
const buildDir = path.join(root, 'build');
fs.mkdirSync(buildDir, { recursive: true });

// Rounded-square mask applied to the real intro-video still (real branded
// artwork beats the hand-drawn SVG mark once we actually had it) — matches
// the corner radius the SVG-based icon used before, so the app doesn't look
// visually different in shape, only in the artwork itself.
async function roundedSquare(sourcePath, size) {
    const square = await sharp(sourcePath).resize(size, size, { fit: 'cover' }).png().toBuffer();
    const radius = Math.round(size * 0.22);
    const mask = Buffer.from(`<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" fill="#fff"/></svg>`);
    return sharp(square).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

async function main() {
    const photoSource = path.join(assetsDir, 'icon-photo-source.png');

    // in-app brand mark: rounded square, real artwork
    const logoBuf = await roundedSquare(photoSource, 512);
    fs.writeFileSync(path.join(assetsDir, 'logo.png'), logoBuf);
    console.log('wrote assets/logo.png');

    // window/taskbar icon: a real multi-resolution .ico (electron-builder requires one)
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    const pngBuffers = [];
    for (const size of sizes) pngBuffers.push(await roundedSquare(photoSource, size));
    const icoBuffer = await pngToIco(pngBuffers);
    fs.writeFileSync(path.join(buildDir, 'icon.ico'), icoBuffer);
    console.log('wrote build/icon.ico');
}

main().catch((err) => { console.error(err); process.exit(1); });
