const fs = require('fs');
const path = require('path');

const packageJsonPath = path.join(__dirname, '../package.json');
const versionJsonPath = path.join(__dirname, '../src/shared/version.json');

try {
  // Read package.json
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const currentVersion = packageJson.version || '1.0.0';

  // Bump patch version (x.y.z -> x.y.(z+1))
  const parts = currentVersion.split('.');
  if (parts.length === 3) {
    parts[2] = String(parseInt(parts[2], 10) + 1);
  } else {
    parts.push('1');
  }
  const newVersion = parts.join('.');

  // Update package.json
  packageJson.version = newVersion;
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');

  // Update/create src/shared/version.json
  const versionData = { version: newVersion };
  fs.writeFileSync(versionJsonPath, JSON.stringify(versionData, null, 2) + '\n', 'utf8');

  console.log(`Bumped version from ${currentVersion} to ${newVersion}`);
} catch (error) {
  console.error('Failed to bump version:', error);
  process.exit(1);
}
