const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = require('node:path').resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);
// bun workspaces monorepo：Expo 会把 git 仓根当 workspace root 并错置 projectRoot，
// bundle 解析因此落到仓根（./node_modules/... 404）。显式钉死两根，解析回到本目录。
config.projectRoot = projectRoot;
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPath = require('node:path').resolve(projectRoot, 'node_modules');

module.exports = config;
