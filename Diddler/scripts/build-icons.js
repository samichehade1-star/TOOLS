// One-off asset build: packs the Diddler "D" mark (assets/logo.png, already a
// transparent 256x256 icon-style graphic) into the multi-resolution
// build/icon.ico that electron-builder requires for the taskbar/installer icon.
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const pngToIco = require('png-to-ico').default;

const root = path.join(__dirname, '..');
const assetsDir = path.join(root, 'assets');
const buildDir = path.join(root, 'build');
fs.mkdirSync(buildDir, { recursive: true });

async function main() {
    const source = path.join(assetsDir, 'logo.png');

    const sizes = [16, 24, 32, 48, 64, 128, 256];
    const pngBuffers = [];
    for (const size of sizes) {
        pngBuffers.push(await sharp(source).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer());
    }
    const icoBuffer = await pngToIco(pngBuffers);
    fs.writeFileSync(path.join(buildDir, 'icon.ico'), icoBuffer);
    console.log('wrote build/icon.ico');
}

main().catch((err) => { console.error(err); process.exit(1); });
