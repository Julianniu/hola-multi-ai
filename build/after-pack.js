// 打包后的处理（electron-builder 的 afterPack）：Mac 版做一个免费的"临时签名"（ad-hoc）。
// 不买证书也必须做：Apple 芯片的 Mac 拒绝运行完全没签名的程序；做了之后用户第一次打开时右键 → 打开即可。
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' });
};
