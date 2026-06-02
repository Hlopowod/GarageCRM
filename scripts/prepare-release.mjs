import fs from 'node:fs';
import path from 'node:path';

const version = process.argv[2]?.trim();

if (!version) {
  console.error('Usage: npm run release:prepare -- <version>');
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Invalid version "${version}". Expected semver like 1.0.1 or 1.1.0-beta.1`);
  process.exit(1);
}

const root = process.cwd();

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function replaceFirst(content, pattern, replacement, filePath) {
  if (!pattern.test(content)) {
    throw new Error(`Could not update version in ${filePath}`);
  }
  return content.replace(pattern, replacement);
}

const packageJsonPath = path.join(root, 'package.json');
const packageLockPath = path.join(root, 'package-lock.json');
const tauriConfigPath = path.join(root, 'src-tauri', 'tauri.conf.json');
const cargoTomlPath = path.join(root, 'src-tauri', 'Cargo.toml');

const packageJson = readJson(packageJsonPath);
packageJson.version = version;
writeJson(packageJsonPath, packageJson);

if (fs.existsSync(packageLockPath)) {
  const packageLock = readJson(packageLockPath);
  packageLock.version = version;
  if (packageLock.packages?.['']) {
    packageLock.packages[''].version = version;
  }
  writeJson(packageLockPath, packageLock);
}

const tauriConfig = readJson(tauriConfigPath);
tauriConfig.version = version;
writeJson(tauriConfigPath, tauriConfig);

const cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
const updatedCargoToml = replaceFirst(
  cargoToml,
  /^version = ".*"$/m,
  `version = "${version}"`,
  cargoTomlPath,
);
fs.writeFileSync(cargoTomlPath, updatedCargoToml);

console.log(`Prepared Garage CRM release ${version}`);
console.log('Next steps:');
console.log(`1. Review changes and commit them`);
console.log(`2. Push the commit to GitHub`);
console.log(`3. Create and push tag v${version} or run the Release workflow manually`);
