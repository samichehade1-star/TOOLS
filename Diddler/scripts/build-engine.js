// One-off build step: publishes the C# capture engine as a self-contained
// single-file win-x64 exe into engine/publish, which electron-builder then
// bundles as an extraResource (see package.json build.extraResources).
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const engineDir = path.join(root, 'engine');
const outDir = path.join(engineDir, 'publish');

const args = [
    'publish',
    path.join(engineDir, 'Diddler.Engine.csproj'),
    '-r', 'win-x64',
    '-c', 'Release',
    '--self-contained', 'true',
    '-p:PublishSingleFile=true',
    '-p:IncludeNativeLibrariesForSelfExtract=true',
    '-o', outDir,
];

console.log('dotnet ' + args.join(' '));
execFileSync('dotnet', args, { stdio: 'inherit' });
console.log('engine published to ' + outDir);
