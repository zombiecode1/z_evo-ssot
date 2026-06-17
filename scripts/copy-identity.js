const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const source = path.join(projectRoot, 'src', 'LangChainAgent', 'identity.json');
const targetDir = path.join(projectRoot, 'dist', 'LangChainAgent');
const target = path.join(targetDir, 'identity.json');

if (fs.existsSync(source)) {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(source, target);
}
