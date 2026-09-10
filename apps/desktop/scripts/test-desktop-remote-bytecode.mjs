import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Compile only the pure program builder: no desktop APIs, windows or input.
const fixtureSource = `
using System;
using System.Reflection;
internal static class RemoteProgramFixture {
  private static void Main() {
    var operands = typeof(RemoteScanProgram).GetNestedType("Operand", BindingFlags.Public | BindingFlags.NonPublic);
    if (operands == null) throw new InvalidOperationException("Remote operand identifiers are unavailable");
    foreach (var name in Enum.GetNames(operands))
      Console.WriteLine(name + "=" + Convert.ToUInt32(Enum.Parse(operands, name)));
    Console.WriteLine(Convert.ToBase64String(RemoteScanProgram.Build(42)));
  }
}`

function decode(bytes) {
  let offset = 0
  const word = () => { const value = bytes.readUInt32LE(offset); offset += 4; return value }
  assert.equal(word(), 0, 'Unsupported bytecode version')
  const arity = new Map([
    [0x01, 2], [0x02, 2], [0x03, 2], [0x04, 1], [0x05, 0], [0x0e, 2], [0x0f, 2],
    [0x18, 2], [0x19, 2], [0x1c, 4], [0x1d, 2], [0x1e, 2], [0x1f, 1], [0x25, 1],
    [0x2a, 2], [0x2c, 3], [0x2e, 2], [0x38, 4], [0x39, 3], [0x3a, 2], [0x3d, 2], [0x3e, 2],
  ])
  const code = []
  while (offset < bytes.length) {
    const opcode = word()
    assert.ok(arity.has(opcode), `Unexpected or potentially mutating opcode: ${opcode}`)
    const args = Array.from({ length: arity.get(opcode) }, word)
    if (opcode === 0x1f) { assert.ok(offset < bytes.length); args.push(bytes[offset++]) }
    code.push([opcode, ...args])
  }
  assert.equal(offset, bytes.length)
  for (const [index, instruction] of code.entries()) {
    if (![0x02, 0x03, 0x04].includes(instruction[0])) continue
    const target = index + (instruction.at(-1) | 0)
    assert.ok(target >= 0 && target < code.length, `Branch ${index} escapes the program`)
  }
  return code
}

function execute(code, ids, root, limit = 200000) {
  const values = { [ids.Root]: root }
  let pc = 0, instructions = 0
  const visited = new Set()
  while (pc < code.length) {
    if (++instructions > limit) return { status: 'instruction-limit', complete: false, instructions }
    const [op, a, b, c, d] = code[pc]
    let next = pc + 1
    switch (op) {
      case 0x01: values[a] = values[b]; break
      case 0x02: if (values[a]) next = pc + (b | 0); break
      case 0x03: if (!values[a]) next = pc + (b | 0); break
      case 0x04: next = pc + (a | 0); break
      case 0x05: return {
        status: 'success', complete: values[ids.Complete], found: values[ids.Found], reason: values[ids.Reason],
        nodes: values[ids.Nodes], maxDepth: values[ids.MaxDepth], instructions, visited,
      }
      case 0x0e: values[a] += values[b]; break
      case 0x0f: values[a] -= values[b]; break
      case 0x18: values[a] ||= values[b]; break
      case 0x19: values[a] = !values[b]; break
      case 0x1c:
        assert.ok([0, 2, 3, 4].includes(d))
        values[a] = d === 0 ? values[b] === values[c] : d === 2 ? values[b] > values[c]
          : d === 3 ? values[b] < values[c] : values[b] >= values[c]
        break
      case 0x1d: values[a] = b | 0; break
      case 0x1e: values[a] = b; break
      case 0x1f: assert.ok(b === 0 || b === 1); values[a] = Boolean(b); break
      case 0x25: values[a] = []; break
      case 0x2a: values[a].push(values[b]); break
      case 0x2c: values[a] = values[b].splice(values[c], 1)[0]; break
      case 0x2e: values[a] = values[b].length; break
      case 0x38: {
        assert.equal(values[d], false, 'Property defaults must match the reference query')
        const property = { 30019: 'password', 30022: 'offscreen', 30002: 'pid' }[values[c]]
        assert.ok(property, 'The scanner accessed an unexpected property')
        values[a] = values[b][property]
        if (property === 'password') visited.add(values[b])
        break
      }
      case 0x39:
        assert.ok(values[c] === 3 || values[c] === 1, 'Navigation escaped child/sibling scope')
        assert.ok(values[b], 'Navigation used a null element')
        values[a] = values[c] === 3 ? values[b].children[0] ?? null : values[b].next ?? null
        break
      case 0x3a: values[a] = values[b] == null; break
      case 0x3d: values[a] = typeof values[b] === 'boolean'; break
      case 0x3e: values[a] = Number.isInteger(values[b]); break
      default: throw new Error(`Unsupported opcode ${op}`)
    }
    pc = next
  }
  throw new Error('The program finished without an explicit halt')
}

const node = (children = [], extra = {}) => ({ children, password: false, offscreen: false, pid: 42, ...extra })
function wire(root) {
  root.children.forEach((child, index) => { child.next = root.children[index + 1] ?? null; wire(child) })
  return root
}

export function testDesktopRemoteBytecode(desktop, output) {
  assert.equal(process.platform, 'win32', 'Compiling the pure builder requires the Windows framework compiler')
  const source = path.join(output, 'RemoteProgramFixture.cs')
  const executable = path.join(output, 'RemoteProgramFixture.exe')
  writeFileSync(source, fixtureSource)
  const compiler = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
  const options = { windowsHide: true, encoding: 'utf8', timeout: 30000 }
  execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/reference:System.dll',
    `/out:${executable}`, source, path.join(desktop, 'native/desktop/RemoteScanProgram.cs')], options)
  const lines = execFileSync(executable, [], options).trim().split(/\r?\n/)
  const code = decode(Buffer.from(lines.pop(), 'base64'))
  const ids = Object.fromEntries(lines.map(line => { const [key, value] = line.split('='); return [key, Number(value)] }))
  for (const name of ['Root', 'Complete', 'Found', 'Reason', 'Nodes', 'MaxDepth']) assert.ok(Number.isInteger(ids[name]))
  const run = (root, limit) => execute(code, ids, wire(root), limit)
  const flat = node(Array.from({ length: 270 }, () => node()))
  flat.next = node([], { password: true })
  let result = run(flat, 10000)
  assert.equal(result.complete, true)
  assert.equal(result.nodes, 270)
  assert.equal(result.visited.size, 270)
  assert.equal(result.found, false, 'The root sibling must not be inspected')
  const wideInstructions = result.instructions
  flat.children[1].password = true; flat.children[1].offscreen = true
  result = run(flat, 10000)
  assert.equal(result.complete, true); assert.equal(result.found, false)
  flat.children[265].password = true
  result = run(flat, 10000)
  assert.equal(result.complete, true); assert.equal(result.found, true); assert.equal(result.nodes, 270)
  const nested = node([node([node(), node([node([], { password: true })])]), node(), node([node()])])
  result = run(nested)
  assert.equal(result.complete, true); assert.equal(result.found, true)
  assert.equal(result.nodes, 7); assert.equal(result.visited.size, 7); assert.equal(result.maxDepth, 3)
  const chain = depth => { let root = node(); for (let index = 0; index < depth; index++) root = node([root]); return root }
  result = run(chain(64)); assert.equal(result.complete, true); assert.equal(result.nodes, 64)
  result = run(chain(65)); assert.equal(result.complete, false); assert.equal(result.reason, 2)
  result = run(node(Array.from({ length: 1024 }, () => node())))
  assert.equal(result.complete, true); assert.equal(result.nodes, 1024)
  result = run(node(Array.from({ length: 1025 }, () => node())))
  assert.equal(result.complete, false); assert.equal(result.reason, 1)
  for (const extra of [{ pid: 99 }, { pid: '42' }]) {
    result = run(node([node([], extra)])); assert.equal(result.complete, false); assert.equal(result.reason, 4)
  }
  for (const extra of [{ password: undefined }, { password: 'false' }, { password: true, offscreen: undefined }]) {
    result = run(node([node([], extra)])); assert.equal(result.complete, false); assert.equal(result.reason, 5)
  }
  result = run(node()); assert.equal(result.complete, true); assert.equal(result.nodes, 0)
  const cycle = wire(node([node(), node()]))
  cycle.children[1].next = cycle.children[0]
  result = execute(code, ids, cycle); assert.equal(result.complete, false); assert.equal(result.reason, 1)
  result = run(flat, 100); assert.equal(result.complete, false); assert.equal(result.status, 'instruction-limit')
  return { passed: true, cases: 16, wideNodes: 270, wideInstructions, staticInstructions: code.length }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const desktop = fileURLToPath(new URL('..', import.meta.url))
  const temporary = path.resolve(desktop, '../../tmp')
  mkdirSync(temporary, { recursive: true })
  const output = mkdtempSync(path.join(temporary, 'remote-bytecode-'))
  console.log(JSON.stringify(testDesktopRemoteBytecode(desktop, output)))
}
