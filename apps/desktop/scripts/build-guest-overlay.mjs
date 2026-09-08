import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

const scriptPath = fileURLToPath(import.meta.url);
const repository = resolve(dirname(scriptPath), '../../..');
const temporaryRoot = join(repository, 'tmp');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function requireChild(parent, candidate) {
  const suffix = relative(parent, candidate);
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error('Image paths must be strict descendants of repository/tmp');
  }
}

async function requireSafePath(target, kind) {
  let current = parse(target).root;
  for (const part of target.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const information = await lstat(current);
    if (information.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${current}`);
  }
  const information = await lstat(target);
  if (kind === 'file' ? !information.isFile() : !information.isDirectory()) {
    throw new Error(`Expected a regular ${kind}: ${target}`);
  }
  return information;
}

async function boundedRead(path, maximum) {
  const information = await requireSafePath(path, 'file');
  if (information.size > maximum) throw new Error(`Input exceeds size limit: ${path}`);
  return readFile(path);
}

async function digestFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function createArchive(sources) {
  const blocks = [];
  for (const [index, source] of [...sources, { name: 'TRAILER!!!', mode: 0, data: Buffer.alloc(0) }].entries()) {
    const name = Buffer.from(`${source.name}\0`, 'utf8');
    const values = [index + 1, source.mode, 0, 0, 1, 0, source.data.length, 0, 0, 0, 0, name.length, 0];
    const header = Buffer.from(`070701${values.map((value) => value.toString(16).padStart(8, '0')).join('')}`);
    blocks.push(header, name, Buffer.alloc((4 - (110 + name.length) % 4) % 4), source.data,
      Buffer.alloc((4 - source.data.length % 4) % 4));
  }
  return Buffer.concat(blocks);
}

async function copyChecked(source, target, expectedHash, suffix = Buffer.alloc(0)) {
  await requireSafePath(source, 'file');
  const output = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  const copiedHash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(source)) {
      copiedHash.update(chunk);
      await output.writeFile(chunk);
    }
    if (copiedHash.digest('hex') !== expectedHash) throw new Error('Base image changed while copying');
    if (suffix.length) await output.writeFile(suffix);
    await output.sync();
  } finally {
    await output.close();
  }
}

export async function buildOverlay(baseArgument, outputArgument) {
  const base = resolve(baseArgument);
  const output = resolve(outputArgument);
  requireChild(temporaryRoot, base);
  requireChild(temporaryRoot, output);
  await requireSafePath(base, 'directory');
  await requireSafePath(dirname(output), 'directory');
  const manifest = (await boundedRead(join(base, 'SHA256SUMS'), 65536)).toString('utf8');
  const expected = new Map();
  for (const line of manifest.split(/\r?\n/).filter(Boolean)) {
    const match = /^([a-fA-F0-9]{64}) [ *]([A-Za-z0-9_.-]+)$/.exec(line);
    if (!match || expected.has(match[2])) throw new Error('Invalid or duplicate base checksum entry');
    expected.set(match[2], match[1].toLowerCase());
  }
  for (const [name, maximum] of [['kernel', 67108864], ['initramfs.cpio.gz', 536870912]]) {
    const path = join(base, name);
    const information = await requireSafePath(path, 'file');
    if (!information.size || information.size > maximum) throw new Error(`Invalid base size: ${name}`);
    if (!expected.has(name) || await digestFile(path) !== expected.get(name)) {
      throw new Error(`Base checksum mismatch: ${name}`);
    }
  }
  const sources = [];
  const sourceMetadata = [];
  for (const [filename, name, mode] of [['init.sh', 'init', 0o100755],
    ['fixture.py', 'opt/worker/fixture.py', 0o100644], ['native_input.py', 'opt/worker/native_input.py', 0o100644]]) {
    const original = await boundedRead(join(repository, 'apps/desktop/e2e/fixtures/guest', filename), 1048576);
    const data = Buffer.from(original.toString('utf8').replace(/\r\n/g, '\n'));
    if (!data.length || data.includes(0) || data.includes(13)) throw new Error(`Invalid guest source: ${filename}`);
    sources.push({ name, mode, data });
    sourceMetadata.push({ file: filename, sha256: sha256(original), payloadSha256: sha256(data), bytes: data.length });
  }
  const archive = createArchive(sources);
  const compressed = gzipSync(archive, { level: 6 });
  await mkdir(output, { recursive: false, mode: 0o700 });
  await requireSafePath(output, 'directory');
  await copyChecked(join(base, 'kernel'), join(output, 'kernel'), expected.get('kernel'));
  await copyChecked(join(base, 'initramfs.cpio.gz'), join(output, 'initramfs.cpio.gz'), expected.get('initramfs.cpio.gz'), compressed);
  const kernelHash = await digestFile(join(output, 'kernel'));
  const imageHash = await digestFile(join(output, 'initramfs.cpio.gz'));
  const metadata = {
    schemaVersion: 1, architecture: 'x86_64',
    base: { directory: relative(repository, base).split(sep).join('/'), kernelSha256: expected.get('kernel'),
      initramfsSha256: expected.get('initramfs.cpio.gz'), manifestSha256: sha256(Buffer.from(manifest)) },
    sources: sourceMetadata, overlay: { sha256: sha256(compressed), bytes: compressed.length, archiveSha256: sha256(archive) },
    output: { kernelSha256: kernelHash, initramfsSha256: imageHash },
  };
  const metadataBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`);
  await writeFile(join(output, 'overlay-metadata.json'), metadataBytes, { flag: 'wx', mode: 0o600 });
  const sums = `${kernelHash}  kernel\n${imageHash}  initramfs.cpio.gz\n${sha256(metadataBytes)}  overlay-metadata.json\n`;
  await writeFile(join(output, 'SHA256SUMS'), sums, { flag: 'wx', mode: 0o600 });
  return { output, overlayBytes: compressed.length, initramfsSha256: imageHash };
}

function selfTest() {
  const input = [{ name: 'init', mode: 0o100755, data: Buffer.from('#!/bin/sh\nexit 0\n') },
    { name: 'opt/worker/fixture.py', mode: 0o100644, data: Buffer.from('value = "한글"\n') }];
  const archive = createArchive(input);
  const decoded = [];
  let offset = 0;
  while (offset < archive.length) {
    assert.equal(archive.toString('ascii', offset, offset + 6), '070701');
    const field = (index) => Number.parseInt(archive.toString('ascii', offset + 6 + index * 8, offset + 14 + index * 8), 16);
    const mode = field(1), size = field(6), length = field(11);
    assert.equal(field(2), 0);
    assert.equal(field(3), 0);
    assert.equal(field(4), 1);
    const name = archive.toString('utf8', offset + 110, offset + 109 + length);
    offset = Math.ceil((offset + 110 + length) / 4) * 4;
    decoded.push({ name, mode, data: archive.subarray(offset, offset + size) });
    offset = Math.ceil((offset + size) / 4) * 4;
  }
  assert.deepEqual(decoded.slice(0, 2), input);
  assert.equal(decoded[2].name, 'TRAILER!!!');
  assert.equal(decoded[2].data.length, 0);
  assert.deepEqual(gunzipSync(gzipSync(archive)), archive);
  assert.deepEqual(gunzipSync(Buffer.concat([gzipSync(archive), gzipSync(archive)])), Buffer.concat([archive, archive]));
  assert.throws(() => requireChild(temporaryRoot, temporaryRoot));
  assert.throws(() => requireChild(temporaryRoot, repository));
  console.log('Guest overlay archive tests passed');
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--self-test') selfTest();
    else if (process.argv.length === 4) console.log(JSON.stringify(await buildOverlay(process.argv[2], process.argv[3])));
    else throw new Error('Usage: node build-guest-overlay.mjs BASE_IMAGE_DIR NEW_OUTPUT_DIR | --self-test');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
