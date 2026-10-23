// Avant de lancer le bureau : la bonne version de Node, et Claude Code installé.
import { execFileSync } from 'node:child_process';
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 18)) {
  console.error(`\n  Le Bureau des agents demande Node.js 22.18 ou plus récent (tu as ${process.versions.node}).`);
  console.error('  Installe la dernière version sur https://nodejs.org, puis relance « npm start ».\n');
  process.exit(1);
}
// sous Windows, claude est souvent un « claude.cmd » (raccourci npm) : il demande cmd.exe, avec des arguments fixes
const essais = process.platform === 'win32' ? [['claude.exe', false], ['claude.cmd', true]] : [['claude', false]];
const trouve = essais.some(([nom, shell]) => {
  try { execFileSync(nom, ['--version'], { stdio: 'ignore', timeout: 15000, shell }); return true; } catch { return false; }
});
if (!trouve) {
  console.warn('\n  ⚠  Claude Code n’est pas trouvé : le bureau s’ouvrira en démo.');
  console.warn('  Installe-le (https://claude.com/claude-code), connecte-toi avec « claude », puis relance « npm start ».\n');
}
