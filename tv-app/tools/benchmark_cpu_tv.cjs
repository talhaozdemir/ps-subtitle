'use strict';

// Isolated, sequential CPU tuning on the configured TV. The current app is
// restored in finally; the benchmark does not change settings or model files.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Writable } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');
const { execFileSync } = require('node:child_process');
const cli = path.join(process.env.APPDATA, 'npm/node_modules/@webos-tools/cli');
const sdk = require(path.join(cli, 'lib/base/novacom'));

async function main() {
  const archive = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]);
  fs.writeFileSync(output, '', { flag: 'wx' });
  const directory = '/tmp/gtavi-cpu-' + crypto.randomBytes(6).toString('hex');
  if (!/^\/tmp\/gtavi-cpu-[0-9a-f]{12}$/.test(directory)) throw Error('Invalid benchmark directory');
  const session = await new Promise((resolve, reject) => {
    const candidate = new sdk.Session('lgtv', false, error => error ? reject(error) : resolve(candidate));
  });
  function run(command, stdout = process.stdout) {
    return new Promise((resolve, reject) => session.run(command, null, stdout, process.stderr, error => error ? reject(error) : resolve()));
  }
  function app(close) {
    const args = [path.join(cli, 'bin/ares-launch.js'), '-d', 'lgtv'];
    if (close) args.push('-c');
    args.push('com.gtavi.turkce');
    process.stdout.write(execFileSync(process.execPath, args));
  }
  const results = [];
  let closed = false;
  try {
    await run('umask 077; mkdir ' + directory);
    await new Promise((resolve, reject) => session.streamPut(directory + '/runtime.tar.gz', fs.createReadStream(archive),
      error => error ? reject(error) : resolve()));
    await run('set -e; cd ' + directory + '; tar xzf runtime.tar.gz; chmod 755 lib/ld-linux-armhf.so.3 paddle-cpu-probe');
    app(true); closed = true;
    await new Promise(resolve => setTimeout(resolve, 4000));
    for (const [round, order] of [[0, [2, 1, 3]], [1, [3, 1, 2]]]) {
      for (const threads of order) {
        let pending = '';
        const decoder = new StringDecoder('utf8');
        const sink = new Writable({ write(chunk, encoding, done) {
          pending += decoder.write(chunk);
          let end;
          while ((end = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, end); pending = pending.slice(end + 1);
            if (!line.trim()) continue;
            try {
              const row = { round, ...JSON.parse(line) };
              results.push(row);
              fs.appendFileSync(output, JSON.stringify(row) + '\n');
              console.log(JSON.stringify(row.frame === undefined ? row : { round, threads, frame: row.frame, ms: row.ms }));
            } catch (error) { return done(error); }
          }
          done();
        } });
        await run('set -e; cd ' + directory + '; ./lib/ld-linux-armhf.so.3 --library-path ./lib ./paddle-cpu-probe . ./cpu-frames-1.0.33.bin ' + threads + ' 1', sink);
      }
    }
  } finally {
    if (closed) { try { app(false); } catch (error) { console.error('Could not restore app: ' + error.message); } }
    try { await run('rm -rf -- ' + directory); } catch (error) { console.error('Benchmark cleanup failed: ' + error.message); }
    session.end();
  }
  if (results.filter(row => row.frame !== undefined).length !== 60) throw Error('Incomplete CPU benchmark');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
