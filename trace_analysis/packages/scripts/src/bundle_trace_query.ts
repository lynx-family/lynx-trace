import { execSync } from 'child_process';
import { join } from 'path';

const rootDir = join(__dirname, '../../..');

function main() {
  console.log('Starting to bundle...');

  try {
    // Build trace_query
    console.log('Building trace_query...');
    execSync('pnpm run build', {
      stdio: 'inherit',
      cwd: join(rootDir, 'packages/trace_query'),
    });

    // Build trace_record
    console.log('Building trace_record...');
    execSync('pnpm run build', {
      stdio: 'inherit',
      cwd: join(rootDir, 'packages/trace_record'),
    });

    // Execute webpack command to bundle both
    console.log('Bundling...');
    execSync(`npx webpack --config ${join(__dirname, '../webpack.config.js')}`, {
      stdio: 'inherit',
      cwd: rootDir,
    });

    console.log('Bundle completed!');
  } catch (error: any) {
    console.error('Bundle failed!');
    if (error.stdout) {
      console.error('stdout:', error.stdout.toString());
    }
    if (error.stderr) {
      console.error('stderr:', error.stderr.toString());
    }
    console.error('Error:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
