import { execSync } from 'child_process';
import { join } from 'path';

const rootDir = join(__dirname, '../../..');

function main() {
  console.log('Starting to bundle trace_record...');

  try {
    // First build trace_record
    console.log('Building trace_record...');
    execSync('pnpm run build', {
      stdio: 'inherit',
      cwd: join(rootDir, 'packages/trace_record'),
    });

    // Execute webpack command to bundle
    console.log('Bundling trace_record...');
    execSync(`npx webpack --config ${join(__dirname, '../webpack.config.js')}`, {
      stdio: 'inherit',
      cwd: rootDir,
    });

    console.log('Bundle completed!');
  } catch (error) {
    console.error('Bundle failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
